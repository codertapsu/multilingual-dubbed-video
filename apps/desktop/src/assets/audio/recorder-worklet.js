/* global AudioWorkletProcessor, registerProcessor -- the AudioWorklet global scope */
// Voice-cloning recorder (shared/voice-library/recorder.ts): hands every block
// of microphone samples to the page, untouched. Served from the app's own
// origin because the content security policy allows scripts from 'self' only.
class VdRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('vd-recorder', VdRecorderProcessor);
