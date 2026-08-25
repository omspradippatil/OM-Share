/**
 * Netlify Serverless Function: Fallback AJAX & Relay Signaling Service
 * Multi-device persistent signaling service with guaranteed serverless relay fallback.
 */

// Ephemeral in-memory store for signaling sessions
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

function cleanupExpired() {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (session.expiresAt && now > session.expiresAt) {
      sessions.delete(code);
    }
  }
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  cleanupExpired();

  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'ok', activeSessions: sessions.size })
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const { action, code, peerId } = payload;

  switch (action) {
    case 'create': {
      const { fileInfo } = payload;
      if (!code || !peerId || !fileInfo) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing parameters' }) };
      }

      sessions.set(code, {
        code,
        senderId: peerId,
        receivers: [],
        fileInfo,
        status: 'sharing',
        offers: [],
        answers: [],
        candidates: [],
        relayRequests: [],
        chunks: [],
        downloadsCount: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, code })
      };
    }

    case 'join': {
      if (!code || !peerId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing code or peerId' }) };
      }

      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found or expired' }) };
      }

      if (!session.receivers.includes(peerId)) {
        session.receivers.push(peerId);
      }
      session.receiverId = peerId;
      session.status = 'sharing';

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          senderId: session.senderId,
          fileInfo: session.fileInfo
        })
      };
    }

    case 'offer': {
      const { offer, to } = payload;
      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
      }

      session.offers.push({ from: peerId, to: to || '', sdp: offer.sdp, type: offer.type, timestamp: Date.now() });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    case 'answer': {
      const { answer, to } = payload;
      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
      }

      session.answers.push({ from: peerId, to: to || '', sdp: answer.sdp, type: answer.type, timestamp: Date.now() });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    case 'candidate': {
      const { candidate, to } = payload;
      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
      }

      session.candidates.push({ from: peerId, to: to || '', candidate, timestamp: Date.now() });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    case 'request-relay': {
      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
      }

      if (!session.relayRequests) session.relayRequests = [];
      if (!session.relayRequests.includes(peerId)) {
        session.relayRequests.push(peerId);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    case 'chunk': {
      const { to, chunkIndex, totalChunks, data, completed } = payload;
      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
      }

      if (!session.chunks) session.chunks = [];
      session.chunks.push({
        from: peerId,
        to: to || '',
        chunkIndex,
        totalChunks,
        data,
        completed: Boolean(completed),
        timestamp: Date.now()
      });

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    case 'poll': {
      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
      }

      const offers = (session.offers || []).filter(o => o.from !== peerId && (!o.to || o.to === peerId));
      const answers = (session.answers || []).filter(a => a.from !== peerId && (!a.to || a.to === peerId));
      const candidates = (session.candidates || []).filter(c => c.from !== peerId && (!c.to || c.to === peerId));
      const relayRequests = session.relayRequests || [];
      const incomingChunks = (session.chunks || []).filter(ch => ch.from !== peerId && (!ch.to || ch.to === peerId));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: session.status,
          receivers: session.receivers,
          receiverId: session.receiverId,
          downloadsCount: session.downloadsCount,
          offers,
          answers,
          candidates,
          relayRequests,
          chunks: incomingChunks
        })
      };
    }

    case 'complete': {
      const session = sessions.get(code);
      if (session) {
        session.downloadsCount = (session.downloadsCount || 0) + 1;
        // Clean up relay chunks for memory efficiency
        session.chunks = [];
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, downloadsCount: session?.downloadsCount || 1 }) };
    }

    case 'cancel': {
      sessions.delete(code);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    default:
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `Unknown action: ${action}` })
      };
  }
};
