// MediaDeviceInfo has no standard lens-type property. Only select a physical
// rear camera when its exposed label identifies the ordinary wide camera.
// Never guess by enumeration order: it can select a selfie/virtual camera.
export function fixedRearCamera(devices: readonly MediaDeviceInfo[]): string | undefined {
  const ordinaryRear = /^(?:(?:back|rear)(?: (?:wide|wide[ -]angle))? camera|(?:后置|後置|背面)(?:广角|廣角)?(?:摄像头|攝像頭|攝影機|相机|相機|镜头|鏡頭)|背面カメラ|rückkamera|caméra arrière|cámara trasera)$/iu;
  return devices.find(device => device.kind === 'videoinput' && !!device.deviceId && ordinaryRear.test(device.label.trim()))?.deviceId;
}

export function rearConstraints(devices: MediaDevices, id?: string): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = id ? { deviceId: { exact: id } } : { facingMode: { ideal: 'environment' } };
  // Ask for native frames instead of browser crop/scale, only when supported.
  const supported = devices.getSupportedConstraints?.() as (MediaTrackSupportedConstraints & { resizeMode?: boolean }) | undefined;
  if (supported?.resizeMode) Object.assign(constraints, { resizeMode: { ideal: 'none' } });
  return constraints;
}

export async function cameraConstraints(devices: MediaDevices, remembered?: string): Promise<MediaTrackConstraints> {
  try {
    if (devices.enumerateDevices) {
      const available = await devices.enumerateDevices();
      const id = fixedRearCamera(available) || (remembered && available.some(device => device.kind === 'videoinput' && device.deviceId === remembered && !device.label) ? remembered : undefined);
      if (id) return rearConstraints(devices, id);
    }
  } catch { /* Enumeration can be unavailable until permission is granted. */ }
  // Leave capture resolution/aspect ratio to the selected device. Imposing a
  // landscape format on a portrait camera can change its crop during startup.
  return rearConstraints(devices);
}
