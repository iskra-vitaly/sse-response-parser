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

    async close() {
        if (this.finishedWith === null) {
            this.clientClosed = true;
            await this.reader.cancel('Client closed the connection');
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
    let {chunk, pos} = yield {};
    let fieldName = '';
    let nameEndChar = 0;
    // Request new chunks until fieldName ending character encountered
    while (nameEndChar === 0) {
        const remainingChunk = chunk.subarray(pos);
        const nameEndIndex = remainingChunk.findIndex(notNameChar);
        let nameChunk = null;
        if (nameEndIndex >= 0) {
            nameChunk = remainingChunk.subarray(0, nameEndIndex);
            nameEndChar = remainingChunk[nameEndIndex];
            pos += nameEndIndex;
        } else {
            // Need more chunks to read the name
            const nextChunk = yield {pos: chunk.byteLength};
            chunk = nextChunk.chunk;
            pos = nextChunk.pos;
            nameChunk = remainingChunk;
        }
        fieldName += ctx.decoder.decode(nameChunk, {stream: true});
    }
    pos++; // Skip the name ending character
    // Flush the decoder
    fieldName += ctx.decoder.decode();
    ctx.decoder = new TextDecoder();
    // Field name without field value is a special case according to the spec
    if (nameEndChar === LF || nameEndChar === CR) {
        /*
          according to spec here https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream
          the value of the feild with the name ending with a line-end should be considered empty string
         */
        ctx.message[fieldName] = '';
        return {pos, nextState: skipLFAfterCR(nameEndChar, fieldStart)};
    } else {
        // Got field name followed by a colon. Now parse the field value.
        return {pos, nextState: fieldValue(fieldName)};
    }
}

function fieldValue(fieldName: string): ParserState {
    return function* (ctx: ParserCtx): ParserStateResult {
        let {chunk, pos} = yield {};
        let fieldValue = '';
        let valueEndChar = 0;
        // Request new chunks until line-end character encountered
        while (valueEndChar === 0) {
            const remainingChunk = chunk.subarray(pos);
            const valueEndIndex = remainingChunk.findIndex(lineEndChar);
            let valueChunk = null;
            if (valueEndIndex >= 0) {
                valueChunk = remainingChunk.subarray(0, valueEndIndex);
                valueEndChar = remainingChunk[valueEndIndex];
                pos += valueEndIndex;
            } else {
                // Need more chunks to read the value
                const nextChunk = yield {pos: chunk.byteLength};
                chunk = nextChunk.chunk;
                pos = nextChunk.pos;
                valueChunk = remainingChunk;
            }
            // Skip leading space
            if (fieldValue === '' && valueChunk.byteLength > 0 && valueChunk[0] === SPACE) {
                valueChunk = valueChunk.subarray(1);
            }
            fieldValue += ctx.decoder.decode(valueChunk, {stream: true});
        }
        pos++; // Skip the line-end character
        // Flush the decoder
        fieldValue += ctx.decoder.decode();
        ctx.decoder = new TextDecoder();
        if (fieldName === 'data') {
            const previous = ctx.message[fieldName] || '';
            fieldValue = previous + fieldValue + '\n';
        }
        ctx.message[fieldName] = fieldValue;
        return {pos, nextState: skipLFAfterCR(valueEndChar as LINE_END, fieldStart)};
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