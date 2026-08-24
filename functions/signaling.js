/**
 * Netlify Serverless Function: Fallback AJAX Signaling Service
 * Provides in-memory / ephemeral signaling when Firebase Firestore is unreachable or blocked.
 * 
 * Endpoints via POST /.netlify/functions/signaling with body:
 * { action: 'create' | 'join' | 'offer' | 'answer' | 'candidate' | 'poll' | 'complete' | 'cancel', ... }
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
        receiverId: null,
        fileInfo,
        status: 'waiting',
        offers: [],
        answers: [],
        candidates: [],
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

      session.receiverId = peerId;
      session.status = 'active';

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

      session.offers.push({ from: peerId, to, sdp: offer.sdp, type: offer.type, timestamp: Date.now() });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    case 'answer': {
      const { answer, to } = payload;
      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
      }

      session.answers.push({ from: peerId, to, sdp: answer.sdp, type: answer.type, timestamp: Date.now() });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    case 'candidate': {
      const { candidate, to } = payload;
      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
      }

      session.candidates.push({ from: peerId, to, candidate, timestamp: Date.now() });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    case 'poll': {
      const session = sessions.get(code);
      if (!session) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
      }

      // Filter offers/answers/candidates intended for this peerId
      const offers = session.offers.filter(o => !o.to || o.to === peerId);
      const answers = session.answers.filter(a => !a.to || a.to === peerId);
      const candidates = session.candidates.filter(c => !c.to || c.to === peerId);

      // Remove returned items so they aren't processed twice
      session.offers = session.offers.filter(o => o.to && o.to !== peerId);
      session.answers = session.answers.filter(a => a.to && a.to !== peerId);
      session.candidates = session.candidates.filter(c => c.to && c.to !== peerId);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          status: session.status,
          receiverId: session.receiverId,
          offers,
          answers,
          candidates
        })
      };
    }

    case 'complete':
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
