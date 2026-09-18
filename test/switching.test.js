const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const switchingCommand = require('../plugin/commands/switching');

function fakeDevice() {
  const sentTexts = [];
  const device = {
    sendText: (msg, node, wantAck) => {
      sentTexts.push({ msg, node, wantAck });
      return Promise.resolve();
    },
  };
  return { device, sentTexts };
}

function fakeApp() {
  const puts = [];
  const app = {
    putSelfPath: (path, value, cb) => {
      puts.push({ path, value });
      cb({ state: 'COMPLETED', statusCode: 200 });
    },
  };
  return { app, puts };
}

function handle(data, from = 1337) {
  const { device, sentTexts } = fakeDevice();
  const { app, puts } = fakeApp();
  const settings = {
    communications: {
      digital_switching: true,
    },
  };
  const msg = { data, from };
  return {
    sentTexts,
    puts,
    result: switchingCommand.handle(msg, settings, device, app),
  };
}

describe('switching command', () => {
  it('accepts switching requests for regular and nested switches', () => {
    const settings = {
      communications: {
        digital_switching: true,
      },
    };
    assert.equal(switchingCommand.accept({ data: 'Turn anchorLight on' }, settings), true);
    assert.equal(switchingCommand.accept({ data: 'Turn gx.gxInternalRelay1 on' }, settings), true);
    assert.equal(switchingCommand.accept({ data: 'Turn gx.gxInternalRelay2 off' }, settings), true);
    assert.equal(switchingCommand.accept({ data: 'hello there' }, settings), false);
  });

  it('does not accept switching requests when digital switching is disabled', () => {
    const settings = {
      communications: {
        digital_switching: false,
      },
    };
    assert.equal(switchingCommand.accept({ data: 'Turn anchorLight on' }, settings), false);
  });

  it('switches a regular relay on and replies to the requester', async () => {
    const { sentTexts, puts, result } = handle('Turn anchorLight on');
    await result;
    assert.equal(puts.length, 1);
    assert.equal(puts[0].path, 'electrical.switches.anchorLight.state');
    assert.equal(puts[0].value, true);
    assert.equal(sentTexts.length, 1);
    assert.equal(sentTexts[0].msg, 'OK, anchorLight is on');
    assert.equal(sentTexts[0].node, 1337);
  });

  it('switches a Cerbo GX relay off and replies to the requester', async () => {
    const { sentTexts, puts, result } = handle('Turn gx.gxInternalRelay2 off');
    await result;
    assert.equal(puts.length, 1);
    assert.equal(puts[0].path, 'electrical.switches.gx.gxInternalRelay2.state');
    assert.equal(puts[0].value, false);
    assert.equal(sentTexts.length, 1);
    assert.equal(sentTexts[0].msg, 'OK, gx.gxInternalRelay2 is off');
    assert.equal(sentTexts[0].node, 1337);
  });
});
