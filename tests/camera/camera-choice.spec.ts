import { test, expect } from '@playwright/test';
import { fixedRearCamera, cameraConstraints } from '../../src/camera-choice';

const device = (label: string, deviceId = label, kind = 'videoinput') => ({ label, deviceId, kind }) as MediaDeviceInfo;

test('physical rear camera is selected by explicit identity rather than virtual-camera order', () => {
  for (const label of ['Back Camera', 'Rear Wide Camera', '后置摄像头', '後置廣角攝影機', '背面カメラ', 'Rückkamera', 'Caméra arrière', 'Cámara trasera']) {
    const devices = [device('Back Triple Camera'), device('Back Dual Wide Camera'), device('Back Ultra Wide Camera'), device('Front Camera'), device(label, 'physical-wide'), device('Back Telephoto Camera')];
    expect(fixedRearCamera(devices)).toBe('physical-wide');
    expect(fixedRearCamera([...devices].reverse())).toBe('physical-wide');
  }
  expect(fixedRearCamera([device('Back Triple Camera'), device('Back Dual Wide Camera'), device('Back Ultra Wide Camera'), device('Front Camera'), device('Back Telephoto Camera')])).toBeUndefined();
  expect(fixedRearCamera([device('Back Camera', '', 'videoinput'), device('Back Camera', 'audio', 'audioinput')])).toBeUndefined();
});

test('constraints pin a recognized rear device and do not impose capture dimensions before permission', async () => {
  const pinned = await cameraConstraints({ enumerateDevices: async () => [device('Front Camera'), device('Back Camera', 'rear')] } as unknown as MediaDevices);
  expect(pinned).toEqual({ deviceId: { exact: 'rear' } });
  for (const devices of [
    { enumerateDevices: async () => [device('', 'hidden'), device('Back Triple Camera', 'virtual')] },
    { enumerateDevices: async () => { throw new DOMException('Not allowed', 'NotAllowedError'); } },
    {}
  ]) expect(await cameraConstraints(devices as unknown as MediaDevices)).toEqual({ facingMode: { ideal: 'environment' } });
});


test('remembered physical identity is reused only while present and not relabeled as another lens', async () => {
  const constraints = async (available: MediaDeviceInfo[]) => cameraConstraints({ enumerateDevices: async () => available } as unknown as MediaDevices, 'rear');
  expect(await constraints([device('', 'rear')])).toEqual({ deviceId: { exact: 'rear' } });
  for (const available of [[device('', 'other')], [device('Front Camera', 'rear')], [device('Back Triple Camera', 'rear')]]) {
    expect(await constraints(available)).toEqual({ facingMode: { ideal: 'environment' } });
  }
});

test('native uncropped capture is requested only when advertised without size or zoom constraints', async () => {
  for (const supported of [false, true]) {
    const result = await cameraConstraints({ getSupportedConstraints: () => ({ resizeMode: supported }) } as unknown as MediaDevices);
    expect(result).toEqual({ facingMode: { ideal: 'environment' }, ...(supported ? { resizeMode: { ideal: 'none' } } : {}) });
  }
});
