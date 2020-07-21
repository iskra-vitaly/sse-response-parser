export interface Message {
    data?: string;
    event?: string;
    id?: string;
    retry?: string;
    [field: string]: string | undefined;
}
export declare enum FinishReason {
    SERVER_CLOSED = "SERVER_CLOSED",
    CLIENT_CLOSED = "CLIENT_CLOSED",
    THROWN = "THROWN",
    HTTP_STATUS = "HTTP_STATUS"
}
export interface ReaderLike {
    cancel(reason?: any): Promise<void>;
    read(): Promise<ReadableStreamReadResult<Uint8Array>>;
}
interface ServerClosedResult {
    reason: FinishReason.SERVER_CLOSED;
}
interface ClientClosedResult {
    reason: FinishReason.CLIENT_CLOSED;
}
interface ThrownResult {
    reason: FinishReason.THROWN;
    error: any;
}
export declare type SSEParseResult = ServerClosedResult | ClientClosedResult | ThrownResult;
export default class SSEResponseParser {
    private readonly reader;
    private clientClosed;
    private finishedWith;
    constructor(reader: ReaderLike);
    close(): Promise<SSEParseResult>;
    [Symbol.asyncIterator](): AsyncGenerator<Message, SSEParseResult>;
    getMessages(): AsyncGenerator<Message, SSEParseResult>;
}
export {};
