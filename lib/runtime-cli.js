import { LocalNeo4j } from './runtime.js';
const runtime = new LocalNeo4j();
try {
    const command = process.argv[2] || 'status';
    if (command === 'status')
        console.log(JSON.stringify(await runtime.status(), null, 2));
    else if (command === 'prepare') {
        await runtime.prepare();
        console.log('Local Neo4j runtime prepared');
    }
    else if (command === 'start') {
        const info = await runtime.startPersistent();
        console.log(`Local Neo4j ready at ${info.uri}`);
    }
    else if (command === 'stop') {
        await runtime.stopPersistent();
        console.log('Local Neo4j stopped');
    }
    else
        throw new Error('Usage: node lib/runtime-cli.js status|prepare|start|stop');
}
catch (error) {
    console.error(error instanceof Error ? error.message : 'Runtime operation failed');
    process.exitCode = 1;
}
//# sourceMappingURL=runtime-cli.js.map