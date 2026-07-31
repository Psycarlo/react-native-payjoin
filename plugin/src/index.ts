import type { ConfigPlugin } from '@expo/config-plugins';
import { createRunOncePlugin, withPlugins } from '@expo/config-plugins';
import { withPayjoinAndroid } from './withAndroid';
import { withPayjoinIOS } from './withIOS';

const pkg = require('../../package.json');

export interface PayjoinPluginProps {
  skipBinaryDownload?: boolean;
}

const withPayjoinReactNative: ConfigPlugin<PayjoinPluginProps | void> = (config, props = {}) => {
  const { skipBinaryDownload = false } = props || {};

  return withPlugins(config, [
    [withPayjoinAndroid, { skipBinaryDownload }],
    [withPayjoinIOS, { skipBinaryDownload }],
  ]);
};

export default createRunOncePlugin(withPayjoinReactNative, pkg.name, pkg.version);
