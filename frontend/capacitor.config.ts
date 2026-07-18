import type { CapacitorConfig } from '@capacitor/cli';

// The web assets are BUNDLED into the app (webDir), not loaded from a remote
// URL. A `server.url` pointing at erp.houzscentury.com would be far easier, but
// App Review rejects remote-shell apps under guideline 4.2 (Minimum
// Functionality) and the app would be unusable with no signal. The API is still
// remote — see src/lib/apiBase.ts for why it targets the Pages origin and not
// the Worker directly.
const config: CapacitorConfig = {
  appId: 'com.houzscentury.erp',
  appName: 'Houzs ERP',
  webDir: 'dist',
  ios: {
    // env(safe-area-inset-*) in mobile.css is what positions the header and tab
    // bar. contentInset 'never' keeps WKWebView from ALSO insetting, which
    // would double-pad the top on notched devices.
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,
    backgroundColor: '#13201cff',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 500,
      launchAutoHide: true,
      backgroundColor: '#13201cff',
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Keyboard: {
      // The SO form is a long scroll of inputs; resizing the body rather than
      // the native frame keeps the sticky footer total visible above the keyboard.
      resize: 'body' as any,
    },
  },
};

export default config;
