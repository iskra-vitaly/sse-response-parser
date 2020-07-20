export default class SSEResponseParser {
    constructor() {
    }
}

class SSEParserState {
    constructor() {
    }

    nextState(input: Uint8Array): SSEParserState {
        return this;
    }
}