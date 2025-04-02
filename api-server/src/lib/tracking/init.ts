import MouseEventTracker from './mouse-events';

let mouseTracker: MouseEventTracker | null = null;

/**
 * Inicializa el seguimiento de eventos para grabación de sesión
 * 
 * @param sessionId ID de la sesión
 * @param visitorId ID del visitante
 * @param siteId ID del sitio
 */
export function initSessionRecording(sessionId: string, visitorId: string, siteId: string) {
  // Solo inicializar si no está ya realizando seguimiento
  if (mouseTracker) return;

  // Crear nueva instancia del rastreador
  mouseTracker = new MouseEventTracker(
    sessionId,
    visitorId,
    siteId,
    window.location.href
  );

  // Comenzar el seguimiento
  mouseTracker.start();

  // Manejar cambios de visibilidad de la página
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      mouseTracker?.stop();
    } else {
      mouseTracker?.start();
    }
  });

  // Manejar cierre de la página
  window.addEventListener('beforeunload', () => {
    mouseTracker?.stop();
    mouseTracker = null;
  });
}

/**
 * Detiene el seguimiento de eventos de sesión
 */
export function stopSessionRecording() {
  if (mouseTracker) {
    mouseTracker.stop();
    mouseTracker = null;
  }
} 