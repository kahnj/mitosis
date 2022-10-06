import dedent from 'dedent';
import { format } from 'prettier/standalone';
import traverse from 'traverse';
import { collectCss } from '../../helpers/styles/collect-css';
import { fastClone } from '../../helpers/fast-clone';
import { getProps } from '../../helpers/get-props';
import { getRefs } from '../../helpers/get-refs';
import { getStateObjectStringFromComponent } from '../../helpers/get-state-object-string';
import { isMitosisNode } from '../../helpers/is-mitosis-node';
import { stripStateAndPropsRefs } from '../../helpers/strip-state-and-props-refs';
import { selfClosingTags } from '../../parsers/jsx';
import { MitosisComponent } from '../../types/mitosis-component';
import { BaseNode, ForNode, MitosisNode } from '../../types/mitosis-node';
import {
  runPostCodePlugins,
  runPostJsonPlugins,
  runPreCodePlugins,
  runPreJsonPlugins,
} from '../../modules/plugins';
import isChildren from '../../helpers/is-children';
import { stripMetaProperties } from '../../helpers/strip-meta-properties';
import { BaseTranspilerOptions, TranspilerGenerator } from '../../types/transpiler';
import { gettersToFunctions } from '../../helpers/getters-to-functions';
import { babelTransformCode } from '../../helpers/babel-transform';
import { isSlotProperty, stripSlotPrefix } from '../../helpers/slots';
import { isUpperCase } from '../../helpers/is-upper-case';
import json5 from 'json5';
import { FUNCTION_HACK_PLUGIN } from './../helpers/functions';
import { getForArguments } from '../../helpers/nodes/for';
import { pipe } from 'fp-ts/lib/function';
import { updateStateSettersInCode } from '../react/state';
import { isValidAttributeName } from '../../helpers/is-valid-attribute-name';
import { processBinding } from '../react/helpers';

export interface ToLWCOptions extends BaseTranspilerOptions {
  stateType?: 'proxies' | 'variables';
}

const mappers: {
  For: BlockToLWC<ForNode>;
  Fragment: BlockToLWC;
  Show: BlockToLWC;
  Slot: BlockToLWC;
} = {
  Fragment: ({ json, options, parentComponent }) => {
    if (json.bindings.innerHTML?.code) {
      return BINDINGS_MAPPER.innerHTML(json, options);
    } else if (json.children.length > 0) {
      return `${json.children
        .map((item) => blockToLWC({ json: item, options, parentComponent }))
        .join('\n')}`;
    } else {
      return '';
    }
  },
  For: ({ json, options, parentComponent }) => {
    const firstChild = json.children[0];
    const keyValue = firstChild.properties.key || firstChild.bindings.key?.code;

    if (keyValue) {
      // we remove extraneous prop which LWC does not use
      delete firstChild.properties.key;
      delete firstChild.bindings.key;
    }

    const args = getForArguments(json, { excludeCollectionName: true }).join(', ');

    return `
<template for:each ${stripStateAndProps(json.bindings.each?.code, options)} ${args} </template> ${
      keyValue ? `(${keyValue})` : ''
    }
${json.children.map((item) => blockToLWC({ json: item, options, parentComponent })).join('\n')}
</template>
`;
  },
  Show: ({ json, options, parentComponent }) => {
    return `
<template if:true=${stripStateAndProps(json.bindings.when?.code, options)} 
${json.children.map((item) => blockToLWC({ json: item, options, parentComponent })).join('\n')}

  ${
    json.meta.else
      ? `
  <template if:true={true}>
  ${blockToLWC({
    json: json.meta.else as MitosisNode,
    options,
    parentComponent,
  })}
  </template`
      : ''
  }
</template>`;
  },
  Slot({ json, options, parentComponent }) {
    if (!json.bindings.name) {
      const key = Object.keys(json.bindings).find(Boolean);
      if (!key) return '<slot />';

      return `
        <span #${key}>
        ${stripStateAndPropsRefs(json.bindings[key]?.code)}
        </span>
      `;
    }
    const strippedTextCode = stripStateAndPropsRefs(json.bindings.name.code);

    return `<slot name="${stripSlotPrefix(strippedTextCode).toLowerCase()}">${json.children
      ?.map((item) => blockToLWC({ json: item, options, parentComponent }))
      .join('\n')}</slot>`;
  },
};

const getContextCode = (json: MitosisComponent) => {
  const contextGetters = json.context.get;
  return Object.keys(contextGetters)
    .map((key) => key)
    .join('');
};

const setContextCode = (json: MitosisComponent) => {
  const contextSetters = json.context.set;
  return Object.keys(contextSetters)
    .map((key) => {
      const { ref, value, name } = contextSetters[key];

      return name;
    })
    .join('');
};

const BINDING_MAPPERS: {
  [key: string]:
    | string
    | ((key: string, value: string, options?: ToLWCOptions) => [string, string]);
} = {
  ref(ref, value, options) {
    const regexp = /(.+)?props\.(.+)( |\)|;|\()?$/m;
    if (regexp.test(value)) {
      const match = regexp.exec(value);
      const prop = match?.[2];
      if (prop) {
        return [ref, prop];
      }
    }
    return [ref, value];
  },
  innerHTML(_key, value) {
    return ['dangerouslySetInnerHTML', `{__html: ${value.replace(/\s+/g, ' ')}}`];
  },
};

const BINDINGS_MAPPER = {
  innerHTML: (json: MitosisNode, options: ToLWCOptions) =>
    `<lightning-formatted-rich-text value="${stripStateAndPropsRefs(
      json.bindings.innerHTML?.code,
    )}"></lightning-formatted-rich-text>`,
};

const getTagName = ({
  json,
  parentComponent,
}: {
  json: MitosisNode;
  parentComponent: MitosisComponent;
}) => {
  return json.name;
};

type BlockToLWC<T extends BaseNode = MitosisNode> = (props: {
  json: T;
  options: ToLWCOptions;
  parentComponent: MitosisComponent;
}) => string;

const stripStateAndProps = (code: string | undefined, options: ToLWCOptions) =>
  stripStateAndPropsRefs(code);

export const blockToLWC: BlockToLWC = ({ json, options, parentComponent }) => {
  if (mappers[json.name as keyof typeof mappers]) {
    return mappers[json.name as keyof typeof mappers]({
      json: json as any,
      options,
      parentComponent,
    });
  }

  const tagName = getTagName({ json, parentComponent });

  if (isChildren(json)) {
    return `<slot></slot>`;
  }

  if (json.properties._text) {
    return json.properties._text;
  }

  const textCode = json.bindings._text?.code;

  if (textCode) {
    const strippedTextCode = stripStateAndProps(textCode, options);
    if (isSlotProperty(strippedTextCode)) {
      return `<slot name="${stripSlotPrefix(strippedTextCode).toLowerCase()}"/>`;
    }
    return `{${strippedTextCode}}`;
  }

  let str = '';

  str += `<${tagName} `;

  if (json.bindings._spread?.code) {
    str += `{...${stripStateAndProps(json.bindings._spread.code, options)}}`;
  }

  const isComponent = Boolean(tagName[0] && isUpperCase(tagName[0]));
  if ((json.bindings.style?.code || json.properties.style) && !isComponent) {
    const useValue = stripStateAndProps(
      json.bindings.style?.code || json.properties.style,
      options,
    );

    str += `use:mitosis_styling={${useValue}}`;
    delete json.bindings.style;
    delete json.properties.style;
  }

  for (const key in json.properties) {
    const value = json.properties[key];
    str += ` ${key}="${value}" `;
  }
  for (const key in json.bindings) {
    const value = String(json.bindings[key]?.code);
    if (key === '_spread') {
      continue;
    }
    if (key === 'css' && value.trim() === '{}') {
      continue;
    }

    const useBindingValue = processBinding(value, {});
    if (key.startsWith('on')) {
      const { arguments: cusArgs = ['event'] } = json.bindings[key]!;
      str += ` ${key}={(${cusArgs.join(',')}) => ${updateStateSettersInCode(
        useBindingValue,
        {},
      )} } `;
    } else if (key.startsWith('slot')) {
      // <Component slotProjected={<AnotherComponent />} />
      str += ` ${key}={${value}} `;
    } else if (key === 'class') {
      str += ` class={${useBindingValue}} `;
    } else if (BINDING_MAPPERS[key]) {
      const mapper = BINDING_MAPPERS[key];
      if (typeof mapper === 'function') {
        const [newKey, newValue] = mapper(key, useBindingValue, options);
        str += ` ${newKey}={${newValue}} `;
      } else {
        str += ` ${BINDING_MAPPERS[key]}={${useBindingValue}} `;
      }
    } else {
      if (isValidAttributeName(key)) {
        str += ` ${key}={${useBindingValue}} `;
      }
    }
  }
  // if we have innerHTML, it doesn't matter whether we have closing tags or not, or children or not.
  // we use the innerHTML content as children and don't render the self-closing tag.
  if (json.bindings.innerHTML?.code) {
    str += '>';
    str += BINDINGS_MAPPER.innerHTML(json, options);
    str += `</${tagName}>`;
    return str;
  }

  if (selfClosingTags.has(tagName)) {
    return str + ' />';
  }
  str += '>';
  if (json.children) {
    str += json.children
      .map((item) => blockToLWC({ json: item, options, parentComponent }))
      .join('');
  }

  str += `</${tagName}>`;

  return str;
};

/**
 * Replace
 *    <input value={state.name} onChange={event => state.name = event.target.value}
 * with
 *    <input bind:value={state.name}/>
 * when easily identified, for more idiomatic LWC code
 */
const useBindValue = (json: MitosisComponent, options: ToLWCOptions) => {
  function normalizeStr(str: string) {
    return str
      .trim()
      .replace(/\n|\r/g, '')
      .replace(/^{/, '')
      .replace(/}$/, '')
      .replace(/;$/, '')
      .replace(/\s+/g, '');
  }
  traverse(json).forEach(function (item) {
    if (isMitosisNode(item)) {
      if (item.bindings.value && item.bindings.onChange) {
        const { arguments: cusArgs = ['event'] } = item.bindings.onChange;
        if (
          normalizeStr(item.bindings.onChange.code) ===
          `${normalizeStr(item.bindings.value.code)}=${cusArgs[0]}.target.value`
        ) {
          item.bindings.value.code = item.bindings.value.code.replace('state.', '');
          item.bindings.onChange.code = item.bindings.onChange.code.replace('state.', '');
        }
      }
    }
  });
};
/**
 * Removes all `this.` references.
 */
const stripThisRefs = (str: string) => {
  return str.replace(/this\.([a-zA-Z_\$0-9]+)/g, '$1');
};

export const componentToLWC: TranspilerGenerator<ToLWCOptions> =
  ({ plugins = [], ...userProvidedOptions } = {}) =>
  ({ component }) => {
    const options: ToLWCOptions = {
      stateType: 'variables',
      prettier: true,
      plugins: [FUNCTION_HACK_PLUGIN, ...plugins],
      ...userProvidedOptions,
    };
    // Make a copy we can safely mutate, similar to babel's toolchain
    let json = fastClone(component);
    if (options.plugins) {
      json = runPreJsonPlugins(json, options.plugins);
    }

    const refs = Array.from(getRefs(json));
    useBindValue(json, options);

    gettersToFunctions(json);

    if (options.plugins) {
      json = runPostJsonPlugins(json, options.plugins);
    }
    const css = collectCss(json);
    stripMetaProperties(json);

    const dataString = pipe(
      getStateObjectStringFromComponent(json, {
        data: true,
        functions: false,
        getters: false,
        format: options.stateType === 'proxies' ? 'object' : 'variables',
        valueMapper: (code) => stripStateAndProps(code, options),
      }),
      babelTransformCode,
    );

    const getterString = pipe(
      getStateObjectStringFromComponent(json, {
        data: false,
        getters: true,
        functions: false,
        format: 'variables',
        keyPrefix: '$: ',
        valueMapper: (code) =>
          pipe(
            code.replace(/^get ([a-zA-Z_\$0-9]+)/, '$1 = ').replace(/\)/, ') => '),
            (str) => stripStateAndProps(str, options),
            stripThisRefs,
          ),
      }),
      babelTransformCode,
    );

    const functionsString = pipe(
      getStateObjectStringFromComponent(json, {
        data: false,
        getters: false,
        functions: true,
        format: 'variables',
        valueMapper: (code) => pipe(stripStateAndProps(code, options), stripThisRefs),
      }),
      babelTransformCode,
    );

    const hasData = dataString.length > 4;

    const props = Array.from(getProps(json)).filter((prop) => !isSlotProperty(prop));

    const transformHookCode = (hookCode: string) =>
      pipe(stripStateAndProps(hookCode, options), babelTransformCode);

    let str = `
    <template>
        ${json.children
          .map((item) =>
            blockToLWC({
              json: item,
              options: options,
              parentComponent: json,
            }),
          )
          .join('\n')}
    </template>

    `;

    const tsLangAttribute = options.typescript ? ` lang='ts'` : '';

    if (options.typescript && json.types?.length) {
      str += dedent`
      <script'${tsLangAttribute}>
        ${json.types ? json.types.join('\n\n') + '\n' : ''}
      </script>
      `;
    }

    // prepare LWC imports
    // let LWCImports: string[] = [];

    // if (json.hooks.onMount?.code?.length) {
    //   LWCImports.push('onMount');
    // }
    // if (json.hooks.onUpdate?.length) {
    //   LWCImports.push('afterUpdate');
    // }
    // if (json.hooks.onUnMount?.code?.length) {
    //   LWCImports.push('onDestroy');
    // }
    // if (hasContext(component)) {
    //   LWCImports.push('getContext', 'setContext');
    // }

    // ${!LWCImports.length ? '' : `import { ${LWCImports.sort().join(', ')} } from 'lwc'`}
    // ${renderPreComponent({ component: json, target: 'lwc' })}
    // ${!hasData || options.stateType === 'variables' ? '' : `import onChange from 'on-change'`}

    // ${
    //     hasStyle(json)
    //       ? `
    //     function mitosis_styling (node, vars) {
    //       Object.entries(vars || {}).forEach(([ p, v ]) => {
    //         if (p.startsWith('--')) {
    //           node.style.setProperty(p, v);
    //         } else {
    //           node.style[p] = v;
    //         }
    //       })
    //     }
    //   `
    //       : ''
    //   }
    //   ${getContextCode(json)}
    //   ${setContextCode(json)}

    // ${
    //     options.stateType === 'proxies'
    //       ? dataString.length < 4
    //         ? ''
    //         : `let state = onChange(${dataString}, () => state = state)`
    //       : dataString
    //   }

    // ${
    //     !json.hooks.onUpdate?.length
    //       ? ''
    //       : json.hooks.onUpdate
    //           .map(({ code, deps }, index) => {
    //             const hookCode = transformHookCode(code);

    //             if (deps) {
    //               const fnName = `onUpdateFn_${index}`;
    //               return `
    //                 function ${fnName}() {
    //                   ${hookCode}
    //                 }
    //                 $: ${fnName}(...${stripStateAndProps(deps, options)})
    //                 `;
    //             } else {
    //               return `afterUpdate(() => { ${hookCode} })`;
    //             }
    //           })
    //           .join(';')
    //   }

    str += dedent`
      <script${tsLangAttribute}>
            import { LightningElement } from 'lwc'
            export default class MyComponent extends LightningElement {
                ${props
                  .map((name) => {
                    if (name === 'children') {
                      return '';
                    }

                    let propDeclaration = `//@api\n${name}`;

                    if (options.typescript && json.propsTypeRef && json.propsTypeRef !== 'any') {
                      propDeclaration += `: ${json.propsTypeRef.split(' |')[0]}['${name}']`;
                    }

                    if (json.defaultProps && json.defaultProps.hasOwnProperty(name)) {
                      propDeclaration += `=${json5.stringify(json.defaultProps[name])}`;
                    }

                    propDeclaration += ';';

                    return propDeclaration;
                  })
                  .join('\n')}

                ${getContextCode(json)}
                ${setContextCode(json)}

                ${functionsString.length < 4 ? '' : functionsString}
                ${getterString.length < 4 ? '' : getterString}

                ${refs.map((ref) => `${stripStateAndPropsRefs(ref)};`).join('\n')}

                ${
                  options.stateType === 'proxies'
                    ? dataString.length < 4
                      ? ''
                      : `let state = onChange(${dataString}, () => state = state)`
                    : dataString
                }

                ${stripStateAndPropsRefs(json.hooks.onInit?.code ?? '')}
                ${
                  !json.hooks.onMount?.code
                    ? ''
                    : `connectedCallback() { 
                            ${transformHookCode(json.hooks.onMount.code)} 
                        });`
                }
                ${
                  !json.hooks.onUnMount?.code
                    ? ''
                    : `disconnectedCallback() { 
                            ${transformHookCode(json.hooks.onUnMount.code)} 
                        });`
                }
            }
        </script>

    ${
      !css.trim().length
        ? ''
        : `<style>
      ${css}
    </style>`
    }
  `;

    if (options.plugins) {
      str = runPreCodePlugins(str, options.plugins);
    }
    if (options.prettier !== false) {
      try {
        str = format(str, {
          parser: 'svelte',
          plugins: [
            // To support running in browsers
            require('prettier/parser-html'),
            require('prettier/parser-postcss'),
            require('prettier/parser-babel'),
            require('prettier/parser-typescript'),
            require('prettier-plugin-svelte'),
          ],
        });
      } catch (err) {
        console.warn('Could not prettify');
        console.warn({ string: str }, err);
      }
    }
    if (options.plugins) {
      str = runPostCodePlugins(str, options.plugins);
    }
    return str;
  };
