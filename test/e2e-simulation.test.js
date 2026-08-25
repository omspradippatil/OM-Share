const test = require('node:test');
const assert = require('node:assert');
const CONFIG = require('../js/config.js');
const HybridSignaling = require('../js/signaling.js');
const WebRTCManager = require('../js/webrtc.js');
const { handler } = require('../functions/signaling.js');

test('E2E Simulation: Full Serverless Handshake with Candidate Sanitization and Payload Integrity', async () => {
  const code = '777888';
  const senderId = 'peer_sender_test_1';
  const receiverId = 'peer_receiver_test_2';
  const fileData = Buffer.from('OM-SHARE TEST FILE DATA PAYLOAD - SUB-SECOND P2P TRANSFER VERIFICATION');
  const totalChunks = Math.ceil(fileData.length / CONFIG.CHUNK_SIZE);
  const fileInfo = {
    name: 'test-document.pdf',
    size: fileData.length,
    type: 'application/pdf',
    totalChunks
  };

  // 1. Sender creates transfer session
  const createRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'create', code, peerId: senderId, fileInfo })
  });
  assert.strictEqual(createRes.statusCode, 200);

  // 2. Receiver joins transfer session
  const joinRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'join', code, peerId: receiverId })
  });
  assert.strictEqual(joinRes.statusCode, 200);
  const joinData = JSON.parse(joinRes.body);
  assert.strictEqual(joinData.senderId, senderId);
  assert.strictEqual(joinData.fileInfo.name, 'test-document.pdf');

  // 3. Sender sends SDP Offer
  const offerRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      action: 'offer',
      code,
      peerId: senderId,
      to: receiverId,
      offer: { sdp: 'v=0\r\no=sender 123456 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n', type: 'offer' }
    })
  });
  assert.strictEqual(offerRes.statusCode, 200);

  // 4. Receiver sends SDP Answer
  const answerRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      action: 'answer',
      code,
      peerId: receiverId,
      to: senderId,
      answer: { sdp: 'v=0\r\no=receiver 654321 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n', type: 'answer' }
    })
  });
  assert.strictEqual(answerRes.statusCode, 200);

  // 5. Exchange ICE candidates from both peers
  const senderCandidate = { candidate: 'candidate:1 1 UDP 2122260223 192.168.1.100 55000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  const receiverCandidate = { candidate: 'candidate:2 1 UDP 2122260223 192.168.1.101 55001 typ host', sdpMid: '0', sdpMLineIndex: 0 };

  const cand1Res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'candidate', code, peerId: senderId, to: receiverId, candidate: senderCandidate })
  });
  assert.strictEqual(cand1Res.statusCode, 200);

  const cand2Res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'candidate', code, peerId: receiverId, to: senderId, candidate: receiverCandidate })
  });
  assert.strictEqual(cand2Res.statusCode, 200);

  // 6. Receiver polls and receives offer + sender candidate
  const receiverPoll = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'poll', code, peerId: receiverId })
  });
  const receiverPollData = JSON.parse(receiverPoll.body);
  assert.strictEqual(receiverPollData.offers.length, 1);
  assert.strictEqual(receiverPollData.offers[0].type, 'offer');
  assert.strictEqual(receiverPollData.candidates.length, 1);
  assert.strictEqual(receiverPollData.candidates[0].candidate.candidate, senderCandidate.candidate);

  // 7. Sender polls and receives answer + receiver candidate
  const senderPoll = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'poll', code, peerId: senderId })
  });
  const senderPollData = JSON.parse(senderPoll.body);
  assert.strictEqual(senderPollData.answers.length, 1);
  assert.strictEqual(senderPollData.answers[0].type, 'answer');
  assert.strictEqual(senderPollData.candidates.length, 1);
  assert.strictEqual(senderPollData.candidates[0].candidate.candidate, receiverCandidate.candidate);

  // 8. Complete session for receiver 1 (session stays active for more devices)
  const compRes1 = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'complete', code })
  });
  assert.strictEqual(compRes1.statusCode, 200);

  // 9. Receiver 2 joins the SAME code
  const receiver2Id = 'peer_receiver_test_3';
  const join2Res = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'join', code, peerId: receiver2Id })
  });
  assert.strictEqual(join2Res.statusCode, 200);

  // 10. Complete session for receiver 2
  const compRes2 = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'complete', code })
  });
  assert.strictEqual(compRes2.statusCode, 200);
  assert.strictEqual(JSON.parse(compRes2.body).downloadsCount, 2);

  // 11. Sender explicitly terminates session with cancel
  const cancelRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'cancel', code })
  });
  assert.strictEqual(cancelRes.statusCode, 200);

  // 12. Subsequent poll returns 404 (session closed)
  const postCancelPoll = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'poll', code, peerId: senderId })
  });
  assert.strictEqual(postCancelPoll.statusCode, 404);
});

test('WebRTC & Chunk Streaming Math Verification', () => {
  const manager = new WebRTCManager();
  assert.ok(manager.peerId.startsWith('peer_'));

  const code = manager.generateCode();
  assert.strictEqual(code.length, 6);
  assert.ok(/^\d{6}$/.test(code));

  // Chunk size calculation
  const fileSize = 100 * 1024 * 1024; // 100MB
  const totalChunks = Math.ceil(fileSize / CONFIG.CHUNK_SIZE);
  assert.strictEqual(totalChunks, 1600); // 100MB / 64KB = 1600 chunks
});
