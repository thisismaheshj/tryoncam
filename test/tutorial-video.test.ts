import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.VTON_SKIP_DOTENV = '1';
const { extractVideoId, isVideoFileUrl, DEFAULT_TUTORIAL_VIDEO } = await import('../src/settings.js');

describe('tutorial video', () => {
  test('keeps an https link to a video file as it is', () => {
    assert.equal(extractVideoId('https://tryoncam.com/assets/demo.mp4'), 'https://tryoncam.com/assets/demo.mp4');
    assert.equal(extractVideoId('  https://cdn.example.com/a/b.webm?v=2 '), 'https://cdn.example.com/a/b.webm?v=2');
  });

  test('still reads every YouTube shape', () => {
    assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  });

  test('refuses links that are not a playable https file', () => {
    assert.equal(isVideoFileUrl('http://tryoncam.com/assets/demo.mp4'), false);
    assert.equal(isVideoFileUrl('javascript:alert(1)//.mp4'), false);
    assert.equal(isVideoFileUrl('https://tryoncam.com/assets/demo.mp4.html'), false);
    assert.equal(extractVideoId('https://example.com/page'), '');
  });

  test('defaults to the demo on YouTube', () => {
    assert.equal(DEFAULT_TUTORIAL_VIDEO, 'ikWsa3Cd8UE');
    assert.equal(extractVideoId('https://www.youtube.com/watch?v=ikWsa3Cd8UE&feature=youtu.be'), 'ikWsa3Cd8UE');
  });
});
