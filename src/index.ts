import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { KumoV3Platform } from './platform';

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, KumoV3Platform);
};
