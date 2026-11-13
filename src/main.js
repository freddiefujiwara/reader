import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { isStagingBuild, showStagingBanner } from './staging-banner.js';

createApp(App).mount('#app');
if (isStagingBuild()) {
  showStagingBanner();
}
