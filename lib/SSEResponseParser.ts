export interface Message {
    data?: string,
    event?: string,
    id?: string,
    retry?: string,

    [field: string]: string | undefined;
}

export enum FinishReason {
    SERVER_CLOSED = 'SERVER_CLOSED',
    CLIENT_CLOSED = 'CLIENT_CLOSED',
    THROWN = 'THROWN',
    HTTP_STATUS = 'HTTP_STATUS',
}

export interface ReaderLike {
    cancel(reason?: any): Promise<void>;

    read(): Promise<ReadableStreamReadResult<Uint8Array>>;
}

interface ServerClosedResult {
    reason: FinishReason.SERVER_CLOSED
}

interface ClientClosedResult {
    reason: FinishReason.CLIENT_CLOSED
}

interface ThrownResult {
    reason: FinishReason.THROWN,
    error: any
}

export type SSEParseResult = ServerClosedResult | ClientClosedResult | ThrownResult;

type ParserStateResult = Generator<ParserOutput, ParserTransition, ParserInput>;

interface ParserCtx {
    message: Message;
    decoder: TextDecoder;
}

type ParserState = (ctx: ParserCtx) => ParserStateResult;

interface ParserInput {
    chunk: Uint8Array;
    pos: number;
}

interface ParserTransition {
    nextState: ParserState;
    pos: number;
}

interface ParserOutput {
    message?: Message;
    pos?: number;
}

const COLON = ':'.charCodeAt(0);
const CR = 0x0D;
const LF = 0x0A;
const SPACE = 0x20;

type LINE_END = typeof CR | typeof LF;

function notNameChar(ch: number): boolean {
    return ch === COLON || ch === CR || ch === LF;
}

function lineEndChar(ch: number): boolean {
    return ch === CR || ch === LF;
}

export default class SSEResponseParser {
    private readonly reader: ReaderLike;
    private clientClosed: boolean = false;
    private finishedWith: SSEParseResult | null = null;

    constructor(reader: ReaderLike) {
        this.reader = reader;
    }

    async close(): Promise<SSEParseResult> {
        if (this.finishedWith === null) {
            this.clientClosed = true;
            await this.reader.cancel('Client closed the connection');
        }
        if (this.finishedWith === null) {
            return {reason: FinishReason.CLIENT_CLOSED};
        } else {
            return this.finishedWith;
        }
    }

    [Symbol.asyncIterator](): AsyncGenerator<Message, SSEParseResult> {
        return this.getMessages();
    }

    async* getMessages(): AsyncGenerator<Message, SSEParseResult> {
        if (this.finishedWith != null) {
            return this.finishedWith;
        }
        const reader = this.reader;
        let state: ParserState = fieldStart;
        try {
            // Initial context
            const ctx = {decoder: new TextDecoder(), message: {}};
            // Accuire parser's messages generator
            let stateIterator = state(ctx);
            let closed = false;
            while (!closed && !this.clientClosed) {
                // Read next chunk
                const nextBuf = await reader.read();
                const chunk = nextBuf.value;
                // Skip empty chunks to avoid extra checks in parser's state-machine
                if (chunk && chunk.byteLength > 0) {
                    let currentPos = 0;
                    // Feed chunk bytes to the state-machine
                    while (currentPos < chunk.byteLength) {
                        // Offer chunk to the parser state
                        const step = stateIterator.next({chunk, pos: currentPos});
                        if (step.done) {
                            // Parser advanced to a next state
                            const {nextState, pos} = step.value;
                            state = nextState;
                            currentPos = pos;
                            // Get new state's iterator
                            stateIterator = state(ctx);
                        } else {
                            // Parser ate the chunk possibly producing a message and advancing a position
                            const result = step.value;
                            if (result.message && Object.keys(result.message).length > 0) {
                                yield result.message;
                            }
                            if (result.pos !== undefined) {
                                currentPos = result.pos;
                            }
                        }
                    }
                }
                closed = nextBuf.done || false;
            }
        } catch (error) {
            this.finishedWith = {reason: FinishReason.THROWN, error};
            throw error;
        }
        if (this.clientClosed) {
            this.finishedWith = {reason: FinishReason.CLIENT_CLOSED};
        } else {
            this.finishedWith = {reason: FinishReason.SERVER_CLOSED};
        }
        return this.finishedWith;
    }
}

type BufferCollectResult = Generator<ParserOutput, { endingChar: number, buffer: string, pos: number }, ParserInput>;

function* fieldStart(ctx: ParserCtx): ParserStateResult {
    const {chunk, pos} = yield {};
    const char = chunk[pos]
    switch (char) {
        case COLON:
            // Skip comment till end of line
            return {pos: pos + 1, nextState: skipComment};
        case LF:
        case CR:
            // Message ended
            yield {message: ctx.message};
            ctx.message = {};
            return {pos: pos + 1, nextState: skipLFAfterCR(char, fieldStart)};
        default:
            return {pos, nextState: fieldName};
    }
}

function* fieldName(ctx: ParserCtx): ParserStateResult {
    const {endingChar, buffer, pos} = yield* collectUntilChar(ctx, notNameChar, false);
    const fieldName = buffer;
    // Field name without field value is a special case according to the spec
    if (endingChar === LF || endingChar === CR) {
        /*
          according to spec here https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
          the value of the feild with the name ending with a line-end should be considered empty string
         */
        ctx.message[fieldName] = '';
        return {pos, nextState: skipLFAfterCR(endingChar, fieldStart)};
    } else {
        // Got field name followed by a colon. Now parse the field value.
        return {pos, nextState: fieldValue(fieldName)};
    }
}

function fieldValue(fieldName: string): ParserState {
    return function* (ctx: ParserCtx): ParserStateResult {
        const {endingChar, buffer, pos} = yield* collectUntilChar(ctx, lineEndChar, true);
        let fieldValue = buffer;
        // Several data values should be concatenated according to a spec
        if (fieldName === 'data') {
            const previous = ctx.message[fieldName] || '';
            fieldValue = previous + fieldValue + '\n';
        }
        ctx.message[fieldName] = fieldValue;
        return {pos, nextState: skipLFAfterCR(endingChar as LINE_END, fieldStart)};
    }
}

function skipLFAfterCR(char: LINE_END, nextState: ParserState): ParserState {
    if (char === LF) {
        // LF is used as a line-end. No need to do anything special
        return nextState
    }

    // CR is used at a line-end. Need to pick if the next char is LF
    return function* () {
        let {chunk, pos} = yield {};

        if (chunk[pos] === LF) {
            // CRLF used as a line end. Skip LF before advancing to a next state
            pos += 1;
        }

        return {pos, nextState}
    };
}

function* skipComment(): ParserStateResult {
    // Only line end can end the comment
    let {chunk, pos} = yield {};
    while (true) {
        const remainingChunk = chunk.subarray(pos);
        const lineEndIndex = remainingChunk.findIndex(lineEndChar);
        if (lineEndIndex >= 0) {
            const lineEndChar = remainingChunk[lineEndIndex] as (typeof LF | typeof CR);
            const nextState = skipLFAfterCR(lineEndChar, fieldStart);
            return {pos: pos + lineEndIndex, nextState};
        }
        const nextChunk = yield {pos: chunk.byteLength};
        chunk = nextChunk.chunk;
        pos = nextChunk.pos;
    }
}

function* collectUntilChar(ctx: ParserCtx,
                           predicate: (ch: number) => boolean,
                           skipLeadingSpace: boolean): BufferCollectResult {
    let {chunk, pos} = yield {};
    let buffer = '';
    let endingChar = 0;
    // Request new chunks until character of interest is encountered
    while (endingChar === 0) {
        const remainingChunk = chunk.subarray(pos);
        const endingIndex = remainingChunk.findIndex(predicate);
        let bytesToAdd = null;
        if (endingIndex >= 0) {
            bytesToAdd = remainingChunk.subarray(0, endingIndex);
            endingChar = remainingChunk[endingIndex];
            pos += endingIndex;
        } else {
            // Need more chunks to read the value
            const nextChunk = yield {pos: chunk.byteLength};
            chunk = nextChunk.chunk;
            pos = nextChunk.pos;
            bytesToAdd = remainingChunk;
        }
        if (skipLeadingSpace) {
            if (buffer === '' && bytesToAdd.byteLength > 0 && bytesToAdd[0] === SPACE) {
                bytesToAdd = bytesToAdd.subarray(1);
            }
        }
        buffer += ctx.decoder.decode(bytesToAdd, {stream: true});
    }
    pos++; // Skip the ending character
    // Flush the decoder
    buffer += ctx.decoder.decode();
    ctx.decoder = new TextDecoder();
    return {endingChar, buffer, pos};
}