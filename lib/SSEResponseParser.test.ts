import SSEResponseParser, {FinishReason, Message, ReaderLike, SSEParseResult} from "./SSEResponseParser";

interface MockedReader {
    readonly reader: ReaderLike;

    push(chunk: string): Promise<void>;

    close(): Promise<void>;

    closed(): boolean;
}

type PullRequest = (value: ReadableStreamReadResult<Uint8Array>) => any;

it('should parse data from a single chunk and handle server close', async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const messages = parser.getMessages();
    await response.push('data:sample data\n\n');
    await checkNextMessage(messages, {data: 'sample data\n'});
    await response.close();
    const closeRes = await messages.next();
    expect(closeRes.done).toBe(true);
    expect(closeRes.value.reason).toBe(FinishReason.SERVER_CLOSED);
});

it('should understand cr and crlf line ending', async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const messages = parser.getMessages();
    await response.push('id:1\rdata:d1\r\n\r\n');
    await checkNextMessage(messages, {
        id: '1',
        data: 'd1\n'
    });
});

it('should handle split inside field name', async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const messages = parser.getMessages();
    await response.push('ev');
    await response.push('ent:value\n\n');
    await checkNextMessage(messages, {
        event: 'value'
    });
});

it('should handle split inside field value', async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const messages = parser.getMessages();
    await response.push('event:va');
    await response.push('lue\n\n');
    await checkNextMessage(messages, {
        event: 'value'
    });
});

it('should ignore comments', async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const messages = parser.getMessages();
    await response.push(':this is a comment inside message\n');
    await response.push('data:value1\n\n');
    await response.push(':this is a comment without message\n\n');
    await response.push('data:value2\n\n');

    await checkNextMessage(messages, {
        data: 'value1\n'
    });
    await checkNextMessage(messages, {
        data: 'value2\n'
    });
});

it('should remove leading space from the field value', async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const messages = parser.getMessages();
    await response.push('data: value\n\n');
    await checkNextMessage(messages, {data: 'value\n'});
});

it('should concatenate all data values', async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const messages = parser.getMessages();
    await response.push('data: first line\n');
    await response.push('data: second line\n');
    await response.push('\n');
    await checkNextMessage(messages, {data: 'first line\nsecond line\n'});
});

it("should allow client to close the stream", async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const messages = parser.getMessages();
    await response.push('id: 1\n\n');
    await response.push('id: 2\n\n');
    await response.push('id: 3\n\n');
    await response.push('id: 4\n\n');
    await checkNextMessage(messages, {id: '1'});
    await checkNextMessage(messages, {id: '2'});
    await parser.close();
    const {done, value} = await messages.next();
    expect(done).toBe(true);
    expect(value.reason).toBe(FinishReason.CLIENT_CLOSED);
});

it("should discard incomplete message", async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const messages = parser.getMessages();
    await response.push('data: first line\ndata: second line\nid: 1\n');
    await response.close();
    const {done, value} = await messages.next();
    expect(done).toBe(true);
    expect(value.reason).toBe(FinishReason.SERVER_CLOSED);
});

it("should be able to iterate over messages", async function () {
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    const testMsgCount = 100;
    for (let i = 1; i <= testMsgCount; i++) {
        await response.push(`id: ${i}\n\n`);
    }
    let msgNum = 1;
    for await (const message of parser) {
        expect(message.id).toBe(`${msgNum}`);
        msgNum++;
        if (msgNum > testMsgCount) break;
    }
    await response.close();
});

it("should work with json data", async function () {
    const obj = {x: 42, y: "hello", z: [1, 2, 3]};
    const json = JSON.stringify(obj);
    const response = mockReader();
    const parser = new SSEResponseParser(response.reader);
    await response.push(`data:${json}\n\n`);
    const messages = parser.getMessages();
    await checkNextMessage(messages, {data: json + '\n'});
    await response.push(`data:${json}\n\n`);
    await checkNextMessage(messages, {data: json + '\n'});
});

async function checkNextMessage(messages: AsyncGenerator<Message, SSEParseResult>, template: object) {
    const {done, value} = await messages.next();
    expect(done).toBe(false);
    expect(value.reason).toBeUndefined();
    expect(value).toMatchObject(template);
    expect(Array.from(Object.keys(value))).toStrictEqual(Array.from(Object.keys(template)));
}

function mockReader(): MockedReader {
    let pushQueue: string[] = [];
    let closed = false;
    let pullQueue: PullRequest[] = [];
    const encoder = new TextEncoder();

    function enqueueRequest(request: PullRequest) {
        if (closed) {
            request({done: true});
        } else if (pushQueue.length > 0) {
            const chunk = pushQueue.shift();
            const value = encoder.encode(chunk);
            request({done: false, value})
        } else {
            pullQueue.push(request)
        }
    }

    function enqueueChunk(chunk: string) {
        if (closed) {
            throw new Error("stream is closed");
        } else if (pullQueue.length > 0) {
            const request = pullQueue.shift();
            const value = encoder.encode(chunk);
            request && request({done: false, value});
        } else {
            pushQueue.push(chunk);
        }
    }

    function close() {
        if (!closed) {
            closed = true;
            pullQueue.forEach(request => request({done: true}));
            pullQueue = [];
            pushQueue = [];
        }
    }

    const reader: ReaderLike = {
        read(): Promise<ReadableStreamReadResult<Uint8Array>> {
            return new Promise(resolve => {
                enqueueRequest(resolve);
            });
        },
        async cancel(): Promise<void> {
            close();
        }
    };

    return {
        reader,
        closed() {
            return closed
        },
        async close() {
            await reader.cancel()
        },
        async push(chunk: string) {
            enqueueChunk(chunk);
        }
    };
}