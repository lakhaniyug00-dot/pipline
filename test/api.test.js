const assert = require('assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = require('../server');
const { requireAuth, generateToken, JWT_SECRET } = require('../middleware/auth');

async function runTests() {
    console.log('🧪 Starting API & Security Test Suite...\n');
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`  ✅ PASS: ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ❌ FAIL: ${name}`);
            console.error(`     ${err.message}`);
            failed++;
        }
    }

    // 1. Health check endpoint
    await test('GET /api/health should respond with status 200', async () => {
        const res = await request(app).get('/api/health');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ok');
        assert.ok('database' in res.body);
    });

    // 2. Unauthenticated access protection
    await test('GET /api/state without token should return 401 Unauthorized', async () => {
        const res = await request(app).get('/api/state');
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.success, false);
        assert.ok(res.body.error.includes('Authentication required'));
    });

    await test('GET /api/history without token should return 401 Unauthorized', async () => {
        const res = await request(app).get('/api/history');
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.success, false);
    });

    await test('GET /api/state with malformed token should return 401 Unauthorized', async () => {
        const res = await request(app)
            .get('/api/state')
            .set('Authorization', 'Bearer invalid-token-xyz');
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.success, false);
        assert.ok(res.body.error.includes('Invalid authentication token'));
    });

    // 3. Password Hashing Security
    await test('bcrypt hashes passwords securely with salt', async () => {
        const password = 'mySecretPassword123!';
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        assert.notStrictEqual(password, hash);
        assert.ok(hash.startsWith('$2'));

        const match = await bcrypt.compare(password, hash);
        assert.strictEqual(match, true);

        const wrongMatch = await bcrypt.compare('wrongPassword', hash);
        assert.strictEqual(wrongMatch, false);
    });

    // 4. JWT Token Generation and Verification
    await test('JWT generates valid token and decodes user payload', async () => {
        const mockUser = {
            _id: '507f1f77bcf86cd799439011',
            username: 'testuser'
        };

        const token = generateToken(mockUser);
        assert.ok(typeof token === 'string');
        assert.ok(token.length > 20);

        const decoded = jwt.verify(token, JWT_SECRET);
        assert.strictEqual(decoded.userId, mockUser._id);
        assert.strictEqual(decoded.username, mockUser.username);
    });

    // 5. User Input Validation for Registration and Login
    await test('POST /api/auth/register rejects short username', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: 'ab', password: 'validPassword123' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.success, false);
        assert.ok(res.body.error.includes('at least 3 characters'));
    });

    await test('POST /api/auth/register rejects short password', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: 'validUser', password: '123' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.success, false);
        assert.ok(res.body.error.includes('at least 6 characters'));
    });

    await test('POST /api/auth/login rejects missing credentials', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: '' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.success, false);
    });

    // 6. End-to-End Registration & Login Flow
    let userAToken = null;
    let userBToken = null;
    // Unique names per test run to avoid 409 conflicts with leftover data
    const testSuffix = Date.now().toString(36);
    const userAName = 'alex_' + testSuffix;
    const userBName = 'bob_' + testSuffix;

    await test('POST /api/auth/register creates user account and returns JWT token', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: userAName, password: 'password123' });
        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.token);
        assert.strictEqual(res.body.user.username, userAName);
        userAToken = res.body.token;
    });

    await test('POST /api/auth/login authenticates user with valid credentials', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: userAName, password: 'password123' });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.token);
    });

    await test('POST /api/auth/login rejects wrong password', async () => {
        const res = await request(app)
            .post('/api/auth/login')
            .send({ username: userAName, password: 'wrongPassword' });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.success, false);
    });

    await test('User A can save and retrieve their private state', async () => {
        const testState = {
            columns: [
                { name: 'Incoming Pipes', items: [{ id: '1', value: '100 - Pipe A', date: '01/01/2026' }] }
            ]
        };

        const saveRes = await request(app)
            .post('/api/state')
            .set('Authorization', `Bearer ${userAToken}`)
            .send({ state: testState });
        assert.strictEqual(saveRes.status, 200);
        assert.strictEqual(saveRes.body.success, true);

        const getRes = await request(app)
            .get('/api/state')
            .set('Authorization', `Bearer ${userAToken}`);
        assert.strictEqual(getRes.status, 200);
        assert.strictEqual(getRes.body.data.columns[0].name, 'Incoming Pipes');
        assert.strictEqual(getRes.body.data.columns[0].items[0].value, '100 - Pipe A');
    });

    await test('Multi-User Isolation: User B cannot view User A data', async () => {
        const regB = await request(app)
            .post('/api/auth/register')
            .send({ username: userBName, password: 'password123' });
        assert.strictEqual(regB.status, 201);
        userBToken = regB.body.token;

        // User B fetches their state
        const getB = await request(app)
            .get('/api/state')
            .set('Authorization', `Bearer ${userBToken}`);
        assert.strictEqual(getB.status, 200);
        // User B's state does NOT have User A's 'Incoming Pipes'
        assert.notStrictEqual(getB.body.data.columns[0]?.name, 'Incoming Pipes');
    });

    // 7. Static files serving
    await test('GET / should serve index.html', async () => {
        const res = await request(app).get('/');
        assert.strictEqual(res.status, 200);
        assert.ok(res.text.includes('Data Tracker') || res.text.includes('html'));
    });

    await test('GET /history should serve history.html', async () => {
        const res = await request(app).get('/history');
        assert.strictEqual(res.status, 200);
        assert.ok(res.text.includes('Deleted History'));
    });

    await test('GET /api-client.js should serve the client script', async () => {
        const res = await request(app).get('/api-client.js');
        assert.strictEqual(res.status, 200);
        assert.ok(res.text.includes('ApiClient'));
    });

    console.log(`\n========================================`);
    console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
    console.log(`========================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test runner failure:', err);
    process.exit(1);
});
