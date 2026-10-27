import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBilibiliPlayback } from '../extension/src/shared/bilibili.ts';

const video = (extra: object = {}) => ({ id: 80, baseUrl: 'https://video.example/1080.m4s?sign=a%2Bb', backupUrl: ['https://backup.example/1080.m4s?sign=keep'], mimeType: 'video/mp4', codecs: 'avc1.640028', bandwidth: 2000000, width: 1920, height: 1080, ...extra });
const audio = (extra: object = {}) => ({ id: 30280, base_url: 'https://audio.example/main.m4s?sign=audio', mime_type: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth: 192000, ...extra });
const playback = (dash: object = {}) => ({ code: 0, data: { support_formats: [{ quality: 80, new_description: '1080P 高清' }], dash: { video: [video()], audio: [audio()], ...dash } } });

test('Bilibili DASH keeps the authorized video/audio pair and exact signed URLs', () => {
  const sources = parseBilibiliPlayback(playback());
  assert.equal(sources.length, 1);
  assert.equal(sources[0].format, 'dash');
  assert.equal(sources[0].url, 'https://video.example/1080.m4s?sign=a%2Bb');
  assert.equal(sources[0].audio?.url, 'https://audio.example/main.m4s?sign=audio');
  assert.equal(sources[0].video?.backupUrls?.[0], 'https://backup.example/1080.m4s?sign=keep');
  assert.equal(sources[0].quality, '1080P 高清');
});

test('Bilibili candidates distinguish codecs and favor AVC with compatible AAC audio', () => {
  const sources = parseBilibiliPlayback(playback({
    video: [video({ codecs: 'av01.0.08M.08', baseUrl: 'https://video.example/av1.m4s' }), video(), video({ id: 64, height: 720, baseUrl: 'https://video.example/720.m4s' })],
    audio: [audio({ codecs: 'ec-3', bandwidth: 1000000 }), audio()],
  }));
  assert.equal(sources.length, 3);
  assert.equal(sources[0].video?.codecs, 'avc1.640028');
  assert.equal(sources[0].video?.height, 1080);
  assert.ok(sources.every(s => s.audio?.codecs === 'mp4a.40.2'));
});

test('Bilibili rejects credential URLs, DRM and excessively large track arrays', () => {
  assert.deepEqual(parseBilibiliPlayback(playback({ video: [video({ baseUrl: 'https://user:password@video.example/v.m4s' })] })), []);
  assert.deepEqual(parseBilibiliPlayback({ code: 0, data: { is_drm: true, dash: { video: [video()], audio: [audio()] } } }), []);
  assert.deepEqual(parseBilibiliPlayback(playback({ video: Array.from({ length: 1000 }, () => video()) })), []);
  assert.deepEqual(parseBilibiliPlayback({ code: -10403, data: { dash: { video: [video()], audio: [audio()] } } }), []);
});

test('Bilibili preserves valid HTTP-FLV and HLS live URLs without inventing signatures', () => {
  const live = (format_name: string, base_url: string) => ({ code: 0, data: { playurl_info: { playurl: { stream: [{ protocol_name: 'http_stream', format: [{ format_name, codec: [{ current_qn: 10000, base_url, url_info: [{ host: 'https://live.example', extra: '?expires=123&sign=keep%2Bthis' }] }] }] }] } } } });
  const flv = parseBilibiliPlayback(live('flv', '/room/live.flv'));
  assert.equal(flv[0]?.url, 'https://live.example/room/live.flv?expires=123&sign=keep%2Bthis');
  assert.equal(flv[0]?.format, 'flv'); assert.equal(flv[0]?.live, true);
  assert.equal(parseBilibiliPlayback(live('ts', '/room/live.m3u8'))[0]?.format, 'hls');
});

test('Bilibili direct durl stays playable while multipart sources are clearly labeled', () => {
  const sources = parseBilibiliPlayback({ code: 0, data: { quality: 64, durl: [{ url: 'https://cdn.example/one.flv' }, { url: 'https://cdn.example/two.flv' }] } });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].format, 'flv');
  assert.match(sources[0].quality ?? '', /分段 1\/2/);
});

test('Bilibili can pair authorized Hi-Res or Dolby audio when the normal AAC list is absent', () => {
  const flac=parseBilibiliPlayback(playback({audio:[],flac:{audio:audio({codecs:'fLaC',base_url:'https://audio.example/hires.m4s'})}}));
  assert.equal(flac[0]?.audio?.codecs,'fLaC');
  const dolby=parseBilibiliPlayback(playback({audio:[],dolby:{audio:[audio({codecs:'ec-3'})]}}));
  assert.equal(dolby[0]?.audio?.codecs,'ec-3');
});
