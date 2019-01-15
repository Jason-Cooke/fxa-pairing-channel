/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

import {
  assert,
  bytesAreEqual,
  hexToBytes,
} from './utils.js';
import {
  ClientHello,
  ServerHello,
  EncryptedExtensions,
  Finished
} from './messages.js';
import {
  HASH_LENGTH, hkdfExpandLabel, hmac
} from './crypto.js';

const PSK_BINDER_SIZE = 32;

//
// State-machine for TLS Handshake Management.
//
// Internally, we manage the TLS connection by explicitly modelling the
// client and server state-machines from RFC8446.  You can think of
// these `State` objects as little plugins for the `Connection` class
// that provide different behaviours of `send` and `receive` depending
// on the state of the connection.
//

class State {

  constructor(conn) {
    this.conn = conn;
  }

  async initialize() {
    // By default, nothing to do when entering the state.
  }

  async sendApplicationData(data) {
    // By default, assume we're not ready to send yet
    // and just let the data queue up for a future state.
    // XXX TODO: should this block until it's successfuly sent?
    this.conn._pendingApplicationData.push(data);
  }

  async recvApplicationData() {
    assert(false, 'not ready to receive application data');
  }

  async recvHandshakeMessage() {
    assert(false, 'not expecting to receive a handhake message');
  }

  async close() {
    assert(false, 'close() not implemented yet');
  }

}

// A special "guard" state to prevent us from using
// an improperly-initialized Connection.

export class UNINITIALIZED extends State {
  async initialize() {
    assert(false, 'uninitialized state');
  }
  async sendApplicationData(data) {
    assert(false, 'uninitialized state');
  }
  async recvApplicationData(record) {
    assert(false, 'uninitialized state');
  }
  async recvHandshakeMessage(type, record) {
    assert(false, 'uninitialized state');
  }
  async close() {
    assert(false, 'uninitialized state');
  }
}

// A special "error" state for when something goes wrong.
// This state never transitions to another state, effectively
// terminating the connection.

export class ERROR extends State {
  async initialize(err) {
    this.error = err;
  }
  async sendApplicationData(data) {
    throw this.error;
  }
  async recvApplicationData(record) {
    throw this.error;
  }
  async recvHandshakeMessage(type, record) {
    throw this.error;
  }
  async close() {
    throw this.error;
  }
}

// The "connected" state, for when the handshake is complete
// and we're ready to send application-level data.
// The logic for this is symmetric between client and server.

export class CONNECTED extends State {
  async initialize() {
    // We can now send any application data that was
    // submitted before the handshake was complete.
    while (this.conn._pendingApplicationData.length > 0) {
      const data = this.conn._pendingApplicationData.shift();
      await this.sendApplicationData(data);
    }
  }
  async sendApplicationData(data) {
    await this.conn._writeApplicationData(data);
    await this.conn._flushOutgoingRecord();
  }
  async recvApplicationData(record) {
    // Application data has no framing, just return the entire buffer.
    return record.slice(0);
  }
}

// These states implement (part of) the client state-machine from
// https://tools.ietf.org/html/rfc8446#appendix-A.1
//
// Since we're only implementing a small subset of TLS1.3,
// we only need a small subset of the handshake.  It basically goes:
//
//   * send ClientHello
//   * receive ServerHello
//   * receive server Finished
//   * send client Finished
//
// We include some unused states for completeness, so that it's easier
// to check the implementation against the diagrams in the RFC.

export class CLIENT_START extends State {
  async initialize() {
    // Write a ClientHello message with our single PSK.
    // We can't know the binder value yet, write zeros for now.
    const clientHello = new ClientHello(
      this.conn.randomSalt,
      new Uint8Array(0),
      [this.conn.pskId],
      [hexToBytes('02741eeff70b084e4f1bc1c8712224f87ef139fa835d4eee0c4f6eb4c064a1ce')] // XXX TODO: calculate PSK binder
    );
    await this.conn._writeHandshakeMessage(clientHello);
    // Now that we know what the ClientHello looks like,
    // go back and calculate the appropriate binder value.
    // XXX TODO: we'll need to actually change the bytes that just got written out.
    await this.conn._flushOutgoingRecord();
    await this.conn._transition(CLIENT_WAIT_SH);
  }
}

class CLIENT_WAIT_SH extends State {
  async recvHandshakeMessage(msg) {
    assert(msg instanceof ServerHello, 'expected ServerHello');
    assert(msg.pskIndex === 0, 'server did not select our offered PSK');
    await this.conn._keyschedule.addECDHE(null);
    await this.conn._setRecvKey(await this.conn._deriveSecret('s hs traffic'));
    await this.conn._setSendKey(await this.conn._deriveSecret('c hs traffic'));
    await this.conn._transition(CLIENT_WAIT_EE, msg);
  }
}

class CLIENT_WAIT_EE extends State {
  async recvHandshakeMessage(msg) {
    // We don't make use of any encrypted extensions,
    // but still have to wait for the (empty) message.
    assert(msg instanceof EncryptedExtensions, 'expected EncryptedExtensions');
    await this.conn._transition(CLIENT_WAIT_FINISHED);
  }
}

class CLIENT_WAIT_FINISHED extends State {
  async recvHandshakeMessage(msg) {
    assert(msg instanceof Finished, 'expected Finished');
    // XXX TODO: calculate and verify server finished hash.
    assert(bytesAreEqual(msg.verifyData, new Uint8Array(HASH_LENGTH)), 'invalid verifyData');
    // XXX TODO: need to calculate client finished hash.
    const verifyData = new Uint8Array(HASH_LENGTH);
    await this.conn._writeHandshakeMessage(new Finished(verifyData));
    await this.conn._flushOutgoingRecord();
    // XXX TODO: calculate new client traffic key, and cause recordSender to start using it.
    // XXX TODO: calculate new server traffic key, and cause recordReceiver to start using it.
    await this.conn._transition(CONNECTED);
  }
}

// These states implement (part of) the server state-machine from
// https://tools.ietf.org/html/rfc8446#appendix-A.2
//
// Since we're only implementing a small subset of TLS1.3,
// we only need a small subset of the handshake.  It basically goes:
//
//   * receive ClientHello
//   * send ServerHello
//   * send server Finished
//   * receive client Finished
//
// We include some unused states for completeness, so that it's easier
// to check the implementation against the diagrams in the RFC.

export class SERVER_START extends State {
  async recvHandshakeMessage(msg) {
    assert(msg instanceof ClientHello, 'expected ClientHello');
    await this.conn._transition(SERVER_RECVD_CH, msg);
  }
}

class SERVER_RECVD_CH extends State {
  async initialize(clientHello) {
    // In the spec, this is where we select connection parameters, and maybe
    // tell the client to try again if we can't find a compatible set.
    // Since we only support a fixed cipherset, the only thing to "negotiate"
    // is whether they provided an acceptable PSK.
    const pskIndex = clientHello.pskIds.findIndex(pskId => bytesAreEqual(pskId, this.conn.pskId));
    assert(pskIndex !== -1, 'client did not offer a matching PSK');
    // XXX TODO: validate the PSK binder.
    // This will involve reading a partial transcript of messages received so far.
    // const pskBinder = clientHello.pskBinders[pskIndex];
    // assert(bytesAreEqual(pskBinder, new Uint8Array(PSK_BINDER_SIZE)));
    await this.conn._transition(SERVER_NEGOTIATED, clientHello.sessionId, pskIndex);
  }
}

class SERVER_NEGOTIATED extends State {
  async initialize(sessionId, pskIndex) {
    await this.conn._writeHandshakeMessage(new ServerHello(this.conn.randomSalt, sessionId, pskIndex));
    await this.conn._flushOutgoingRecord();
    await this.conn._keyschedule.addECDHE(null);
    const serverHandshakeKey = await this.conn._deriveSecret('s hs traffic')
    await this.conn._setRecvKey(await this.conn._deriveSecret('c hs traffic'));
    await this.conn._setSendKey(serverHandshakeKey);
    // Send an empty EncryptedExtensions message.
    await this.conn._writeHandshakeMessage(new EncryptedExtensions());
    await this.conn._flushOutgoingRecord();
    // Send the Finished message.
    // XXX TODO: need to calculate server finished hash.
    const finishedKey = await hkdfExpandLabel(serverHandshakeKey, 'finished', new Uint8Array(0), HASH_LENGTH);
    const verifyData = await hmac(finishedKey, await this.conn._keyschedule.getCurrentTranscriptHash());
    await this.conn._writeHandshakeMessage(new Finished(verifyData));
    await this.conn._flushOutgoingRecord(); // XXX TODO: maybe implicit flush when changing keys?
    await this.conn._keyschedule.finalize();
    await this.conn._setSendKey(await this.conn._deriveSecret('s ap traffic'));
    // Since we don't ask for any client auth,
    // we can transition directly to WAIT_FINISHED state.
    await this.conn._transition(SERVER_WAIT_FINISHED, await this.conn._deriveSecret('c ap traffic'));
  }
}

class SERVER_WAIT_FINISHED extends State {
  async initialize(clientTrafficKey) {
    // We can't switch to the client's application traffic key
    // until after we receive the client Finished message,
    // but we must calculate the key before receiving the Finished message
    // so it doesn't end up in the transcript.
    this._pendingClientTrafficKey = clientTrafficKey;
  }
  async recvHandshakeMessage(msg) {
    assert(msg instanceof Finished, 'expected Finished');
    // XXX TODO: calculate and verify client finished hash.
    //assert(bytesAreEqual(msg.verifyData, new Uint8Array(HASH_LENGTH)), 'invalid verify_data');
    await this.conn._setRecvKey(this._pendingClientTrafficKey);
    this._pendingClientTrafficKey = null;
    await this.conn._transition(CONNECTED);
  }
}
