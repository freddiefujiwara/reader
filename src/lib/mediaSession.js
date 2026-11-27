// Translate browser/lock-screen actions into the existing player controls.
// Playback state and recovery decisions remain with the player.
export function setPlayerMediaSession(article, { play, pause, seek, skipTrack }) {
  const session = globalThis.navigator?.mediaSession;
  if (!session || typeof MediaMetadata === 'undefined') return;
  try {
    session.metadata = new MediaMetadata({
      title: article.title,
      artist: article.feedTitle || article.feedId || '',
    });
    session.setActionHandler('play', () => play());
    session.setActionHandler('pause', () => pause());
    session.setActionHandler('seekbackward', () => seek(-15));
    session.setActionHandler('seekforward', () => seek(30));
    session.setActionHandler('previoustrack', () => skipTrack(-1));
    session.setActionHandler('nexttrack', () => skipTrack(1));
  } catch {
    // Media Session is optional; unsupported browsers still play normally.
  }
}

export function clearPlayerMediaSession() {
  const session = globalThis.navigator?.mediaSession;
  if (!session) return;
  try {
    session.metadata = null;
  } catch {
    // Browsers may reject writes to their Media Session.
  }
}
