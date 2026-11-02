import { createSourceMock } from '../mock/sourceMock.js';

const mock = createSourceMock({ count: 300 });
const url = await mock.start(4010);
console.log(`Mock API running at ${url}`);
console.log('client_id:', mock.credentials.clientId, ' client_secret:', mock.credentials.clientSecret);
console.log('Press Ctrl+C to stop.');