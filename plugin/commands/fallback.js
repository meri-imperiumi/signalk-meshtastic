// Direct messages that match no command get a one-line explanation, so that
// somebody who found the node in their app doesn't wait for a human that
// isn't there. Delivery is best effort: the firmware refuses to send a direct
// message to a node whose public key it doesn't hold, and the other end can
// only decrypt the reply once it has our key.
//
// Replies are rate limited per node, both to keep two automated nodes from
// answering each other back and forth and to save airtime on a busy mesh.
const REPLY_INTERVAL_MS = 60 * 60 * 1000;

const lastReply = new Map();

function prune(now) {
  lastReply.forEach((sent, node) => {
    if (now - sent >= REPLY_INTERVAL_MS) {
      lastReply.delete(node);
    }
  });
}

function message(commands) {
  return `Automated boat node, nobody reads this. Commands: ${commands.join(', ')}`;
}

function handle(msg, device, commands, now = Date.now()) {
  prune(now);
  if (lastReply.has(msg.from)) {
    return Promise.resolve(false);
  }
  lastReply.set(msg.from, now);
  return device.sendText(message(commands), msg.from, true, false)
    .then(() => true);
}

function reset() {
  lastReply.clear();
}

module.exports = {
  handle,
  message,
  reset,
  REPLY_INTERVAL_MS,
};
