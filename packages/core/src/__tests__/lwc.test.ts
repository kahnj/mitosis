import { componentToLWC } from '../generators/lwc';
import { runTestsForTarget } from './shared';

describe('LWC', () => {
  runTestsForTarget({
    target: 'lwc',
    generator: componentToLWC,
    options: {},
  });
});
