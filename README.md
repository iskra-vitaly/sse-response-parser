# SSE Response parser

This library allows to parse a sse response (Content-Type: text/event-stream)
as an iterable of messages.

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
    for (const message of parser) {
        console.log(`Got message ${message.data}`, message);
    }
}

function handleCloseButtonClick() {
    if (closeConnection) {
        closeConnection();
    }
} 
```
