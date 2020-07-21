# SSE Response parser

This library allows to parse a sse response (`Content-Type: text/event-stream`)
as an async iterable of messages.

lib/SSEResponseParser.ts – source code
dist/SSEResponseParser.js – compiled typescript
dist/SSEResponseParser.d.ts – type definitions

## Usage

```js
import SSEResponseParser from "./dist/SSEResponseParser.js"; 

let closeConnection = null;

async function logAllSseMessages(uri) {
    const response = await fetch(uri);
    const parser = new SSEResponseParser(response);
    // Store a function able to close a connection from the browser
    closeConnection = () => parser.close();
    // Iterate messages until SSE connection is closed by either server or the client 
    for await (const event of parser) {
        console.log(`Got message. Data: ${event.data}; Event: ${event.event}`, event);
    }
}

function handleCloseButtonClick() {
    if (closeConnection) {
        closeConnection();
    }
} 
```
