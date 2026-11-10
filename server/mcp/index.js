#!/usr/bin/env node
/**
 * Entry point for the Narrative Engine MCP server.
 *
 *   node server/mcp/index.js          stdio (Claude Desktop, Claude Code)
 *   node server/mcp/index.js --http   Streamable HTTP on 127.0.0.1:$MCP_PORT (default 3002),
 *                                     for clients that connect by URL (put a tunnel in front
 *                                     of it for claude.ai)
 *
 * The Narrative Engine server must be running (npm run dev). Point at a
 * non-default one with NARRATIVE_ENGINE_URL.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { createEngineClient, DEFAULT_ENGINE_URL } from './engineClient.js';
import { createEngineLauncher } from './engineLauncher.js';

const baseUrl = (process.env.NARRATIVE_ENGINE_URL || DEFAULT_ENGINE_URL).replace(/\/+$/, '');
const client = createEngineClient({ baseUrl, ensureEngine: createEngineLauncher({ baseUrl }) });

if (process.argv.includes('--http')) {
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { createMcpExpressApp } = await import('@modelcontextprotocol/sdk/server/express.js');
    const app = createMcpExpressApp();
    app.post('/mcp', async (req, res) => {
        const server = buildServer(client);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });
    const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    app.get('/mcp', notAllowed);
    app.delete('/mcp', notAllowed);
    const port = Number(process.env.MCP_PORT ?? 3002);
    app.listen(port, '127.0.0.1', (err) => {
        if (err) { console.error(`[MCP] failed to listen on ${port}: ${err.message}`); process.exit(1); }
        console.error(`[MCP] Narrative Engine MCP server on http://127.0.0.1:${port}/mcp (engine: ${client.baseUrl})`);
    });
} else {
    // stdout is the protocol channel in stdio mode: everything else goes to stderr.
    console.log = (...args) => console.error(...args);
    console.info = console.log;
    const server = buildServer(client);
    await server.connect(new StdioServerTransport());
    console.error(`[MCP] Narrative Engine MCP server ready on stdio (engine: ${client.baseUrl})`);
}
