import { AppRegistry } from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';
import App from './App';
import { name as appName } from './app.json';
import { headlessTask } from './src/lib/backgroundSync';

AppRegistry.registerComponent(appName, () => App);
BackgroundFetch.registerHeadlessTask(headlessTask);
