// MediaDeviceInfo has no standard lens-type property. Only select a physical
// rear camera when its exposed label identifies the ordinary wide camera.
// Never guess by enumeration order: it can select a selfie/virtual camera.
export function fixedRearCamera(devices: readonly MediaDeviceInfo[]): string | undefined {
  const ordinaryRear = /^(?:(?:back|rear)(?: (?:wide|wide[ -]angle))? camera|(?:后置|後置|背面)(?:广角|廣角)?(?:摄像头|攝像頭|攝影機|相机|相機|镜头|鏡頭)|背面カメラ|rückkamera|caméra arrière|cámara trasera)$/iu;
  return devices.find(device => device.kind === 'videoinput' && !!device.deviceId && ordinaryRear.test(device.label.trim()))?.deviceId;
}

export async function cameraConstraints(devices: MediaDevices): Promise<MediaTrackConstraints> {
  try {
    if (devices.enumerateDevices) {
      const id = fixedRearCamera(await devices.enumerateDevices());
      if (id) return { deviceId: { exact: id } };
    }
  } catch { /* Enumeration can be unavailable until permission is granted. */ }
  // Leave capture resolution/aspect ratio to the selected device. Imposing a
  // landscape format on a portrait camera can change its crop during startup.
  return { facingMode: { ideal: 'environment' } };
}
