const test = require('node:test');
const assert = require('node:assert');
const { handler } = require('../functions/signaling.js');

test('Serverless signaling function lifecycle: create -> join -> offer -> answer -> candidate -> poll -> complete', async () => {
  const code = '987654';
  const senderId = 'peer_sender_123';
  const receiverId = 'peer_receiver_456';
  const fileInfo = { name: 'test.pdf', size: 1024 * 1024, type: 'application/pdf', totalChunks: 16 };

  // 1. Create transfer
  const createRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'create', code, peerId: senderId, fileInfo })
  });
  assert.strictEqual(createRes.statusCode, 200);
  assert.strictEqual(JSON.parse(createRes.body).success, true);

  // 2. Join transfer as receiver
  const joinRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'join', code, peerId: receiverId })
  });
  assert.strictEqual(joinRes.statusCode, 200);
  const joinBody = JSON.parse(joinRes.body);
  assert.strictEqual(joinBody.senderId, senderId);
  assert.strictEqual(joinBody.fileInfo.name, 'test.pdf');

  // 3. Sender sends Offer
  const offerRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      action: 'offer',
      code,
      peerId: senderId,
      to: receiverId,
      offer: { sdp: 'fake-offer-sdp', type: 'offer' }
    })
  });
  assert.strictEqual(offerRes.statusCode, 200);

  // 4. Receiver polls for Offer
  const receiverPoll = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'poll', code, peerId: receiverId })
  });
  assert.strictEqual(receiverPoll.statusCode, 200);
  const receiverPollBody = JSON.parse(receiverPoll.body);
  assert.strictEqual(receiverPollBody.offers.length, 1);
  assert.strictEqual(receiverPollBody.offers[0].sdp, 'fake-offer-sdp');

  // 5. Receiver sends Answer
  const answerRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      action: 'answer',
      code,
      peerId: receiverId,
      to: senderId,
      answer: { sdp: 'fake-answer-sdp', type: 'answer' }
    })
  });
  assert.strictEqual(answerRes.statusCode, 200);

  // 6. Sender polls for Answer
  const senderPoll = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'poll', code, peerId: senderId })
  });
  assert.strictEqual(senderPoll.statusCode, 200);
  const senderPollBody = JSON.parse(senderPoll.body);
  assert.strictEqual(senderPollBody.answers.length, 1);
  assert.strictEqual(senderPollBody.answers[0].sdp, 'fake-answer-sdp');

  // 7. Complete transfer
  const completeRes = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'complete', code })
  });
  assert.strictEqual(completeRes.statusCode, 200);

  // 8. Subsequent poll returns 404
  const postCompletePoll = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({ action: 'poll', code, peerId: senderId })
  });
  assert.strictEqual(postCompletePoll.statusCode, 404);
});
