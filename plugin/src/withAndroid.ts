import { type ConfigPlugin, withGradleProperties } from '@expo/config-plugins';

const withGradlePropertiesConfig: ConfigPlugin = (config) => {
  return withGradleProperties(config, (config) => {
    config.modResults = config.modResults.filter(
      (item) => item.type !== 'property' || item.key !== 'android.useAndroidX'
    );

    config.modResults.push({
      type: 'property',
      key: 'android.useAndroidX',
      value: 'true',
    });

    return config;
  });
};

export const withPayjoinAndroid: ConfigPlugin = (config) => {
  config = withGradlePropertiesConfig(config);

  return config;
};
