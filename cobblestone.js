'use strict';

{

//
// settings
//

const templateSelector = 'script[type="text/x-cob"]';
const funcCommentStart = '\n/* * * begin function augmentation * * */\n';
const funcCommentEnd = '\n/* * * end function augmentation * * */\n';
const patterns = {
    opening: '{\\s*',
    closing: '\\s*}',
    variable: '[A-Za-z_$][A-Za-z0-9_$]*'
};

// Make a named constructor for generator functions, like Function(),
// since JavaScript does not provide it natively.
const GeneratorFunction = Object.getPrototypeOf(function*(){}).constructor;

const dataKeys = {};
const getters = {};
const proxyMap = new Map();
const regExps = {};
const templates = [];

// Build up all patterns from the basic ones, above
patterns.funcAug = escRegExp(funcCommentStart) + '.+?' + escRegExp(funcCommentEnd);
patterns.variablePath = '(' + patterns.variable + '(\\.' + patterns.variable + ')*)';
patterns.interpolation = patterns.opening + patterns.variablePath + patterns.closing;
patterns.ifOpening = patterns.opening + 'if\\s+' + patterns.variablePath + patterns.closing;
patterns.ifClosing = patterns.opening + '/\\s*if' + patterns.closing;
patterns.elif = patterns.opening + 'elif\\s+' + patterns.variablePath + patterns.closing;
patterns.else = patterns.opening + 'else' + patterns.closing;
patterns.eachOpening = patterns.opening + 'each\\s+' + patterns.variablePath +
    '\\s+as\\s+(' + patterns.variable + ')' + patterns.closing;
patterns.eachClosing = patterns.opening + '/\\s*each' + patterns.closing;
patterns.blockSplit = '(' + [ patterns.ifOpening, patterns.else, patterns.ifClosing,
        patterns.eachOpening, patterns.eachClosing ].join('|') + ')';
patterns.blockOpening = '^' + patterns.opening + '(each|if)';
patterns.element = '<[^>]+{[^>]+>';
patterns.quote = '[\'"]?';
patterns.attrVal = patterns.quote + patterns.interpolation + patterns.quote;
patterns.attrKey = '([A-Za-z-]+)=' + patterns.attrVal;
patterns.comment = '^{(.+)}$';

const patternFlags = {
    attrKey: 'g',
    attrVal: 'g',
    comment: 's',
    element: 'g',
    interpolation: 'g',
    funcAug: 'gs'
};

// Set up Regular Expression objects, for reuse
for (let key in patterns) {
    let val = patterns[key];
    let flags = (patternFlags[key] || '');
    regExps[key] = new RegExp(val, flags);
}

const blockSplitInterval = 7;


//
// helpers
//

function escRegExp(s) {
    return s.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

function isObject(value) {
    return ('[object Object]' === Object.prototype.toString.call(value));
}

function isWritable(obj, prop) {
    let des = Object.getOwnPropertyDescriptor(obj, prop),
        writable = Boolean(
            ('function' !== typeof obj[prop]) &&
            (des.set || des.writable)
        );
    return writable;
}

function isAGetter(obj, prop) {
    let des = Object.getOwnPropertyDescriptor(obj, prop),
        getter = Boolean(des.get);
    return getter;
}

function isRef(value) {
    return (Array.isArray(value) || isObject(value));
}

function getCacheValue(value) {
    if (isRef(value)) { value = JSON.stringify(value); }
    return value;
}

function canProxy(value) {
    return isRef(value);
}

function makePath(prefix, key) {

    let path;

    if (0 === prefix.length) {
        path = key;
    } else {
        if (/^\d+$/.test(key)) {
            path = prefix + '[' + key + ']';
        } else {
            path = prefix + '.' + key;
        }
    }

    return path;
}

function splitPath(path) {
    let keys = path.split(/\]?[\.\[\]]/);
    if ('' === keys.at(-1)) { keys.pop(); }
    return keys;
}

function getValueByPath(obj, path) {

    let keys = splitPath(path),
        val = obj;

    for (let key of keys) {
        if (key in val) {
            val = val[key];
        } else {
            val = undefined;
            break;
        }
    }

    return val;
}

function setValueByPath(obj, path, val) {

    let keys = splitPath(path),
        lastKey = keys.pop();

    for (let key of keys) { obj = obj[key]; }

    obj[lastKey] = val;
}

// Translate a variable that may have some aliases from each-loops
// to its full path from the context object
function getFullPath(key, env) {

    let path = [];

    // Get the first segment
    key = key.split('.');
    let lead = key.shift();

    // Save the rest, if any
    if (key.length) {
        key = key.join('.');
        path.push(key);
    }

    // Match the lead to the aliases,
    // all of the way to the root of the context
    for (let a of env.aliases) {
        let [ k, v ] = [...a];
        if (lead === k) {
            let subenv = { aliases: env.aliases };
            lead = getFullPath(v, subenv);
            break;
        }
    }


    path.push(lead);

    if ('dataKey' in env) { path.push(env.dataKey); }

    // The aliases were reverse-sorted, and the lead was just pushed to the end.
    // So, the path is backwards. So reverse it.
    path = path.reverse().join('.');

    return path;
}

function getDataSource(path) {

    let dataKey, dataVal, prefix;

    for (let key in dataKeys) {
        prefix = key + '.';
        if (path.startsWith(prefix)) {
            dataKey = key;
            dataVal = dataKeys[ key ];
            break;
        }
    }

    return [ dataKey, dataVal ];
}


function deleteNodesBetween(firstNode, lastNode) {
    while (lastNode.previousSibling !== firstNode) {
        lastNode.previousSibling.remove();
    }
}

// Recreate aliases created by surrounding each-loops
// with their as-clauses.
// (This is prepended to templates and inline functions)
function importAliases(env) {

    let head = [];

    for (let k of Object.keys(env.dataVal)) {
        head.push(k + ' = ' + env.dataKey + '.' + k);
    }

    for (let a of env.aliases) { head.push(a.join(' = ')); }

    head = head.join(',\n    ');

    if (head.length) { head = `let ${head};`; }

    return head;
}

// Update the values of any array items
// that were changed by updates to their aliases
// (This is appended to inline functions.)
function exportAliases(env) {

    let tail = [],
        tailAliases = [ ...env.aliases ];

    tailAliases.reverse();

    for (let a of tailAliases) {
        a = a.slice().reverse().join(' = ');
        tail.push(a);
    }

    for (let k of Object.keys(env.dataVal)) {
        if (isWritable(env.dataVal, k)) {
            tail.push(env.dataKey + '.' + k + ' = ' + k);
        }
    }

    tail = tail.join(';\n');
    if (tail.length) { tail = tail + ';'; }

    return tail;
}

// Separate any else-if statements into independent else- and if-statements.
// They route the same way but index more easily.
function splitElifBlocks(template) {

    let oldRegExp = [
        patterns.ifOpening,
        patterns.ifClosing,
        patterns.elif
    ].join('|');

    oldRegExp = new RegExp(oldRegExp, 'g');

    while (regExps.elif.test(template)) {
        let openIfs = 0;
        template = template.replace(oldRegExp, function (match) {
            if (regExps.ifOpening.test(match)) {
                if (openIfs) { openIfs++; }
            } else if (regExps.elif.test(match)) {
                if (0 === openIfs) {
                    match = match.replace(regExps.elif, '{else}{if $1}');
                    openIfs++;
                }
            } else {   // {/if}
                if (openIfs) {
                    openIfs--;
                    if (0 === openIfs) { match += match; }
                }
            }

            return match;
        });
    }

    return template;
}

//  Translate template syntax to JavaScript code
function templateToFunction(template, env) {

    // Escape backticks
    template = template.replace('`', '\\`');

    // Parse blocks
    let pieces = template.split(regExps.blockSplit);

    template = [];

    // Splitting the blocks by the regular expression
    // yields too many elements, because of parentheses.
    // Reduce the array to alternating blocks and HTML.
    for (let i = 1; i < pieces.length; i += blockSplitInterval) {
        template.push(pieces[i - 1]);  // the HTML in between
        template.push(pieces[i]);      // the template block
    }

    template.push(pieces.at(-1));

    // First go through the template blocks,
    // skipping the content between.
    for (let i = 1; i < (template.length - 3); i += 2) {
        let section = template[i];
        let match = section.match(regExps.blockOpening);
        if (regExps.else.test(section)) {
            // else-clauses are easy to translate
            section = '} else {';
        } else if (match) {
            // We have just found the beginning of an if-statement or each-loop.
            let type = match[1],
                blockClosing = '{/' + type + '}',
                extraOpening = new RegExp('^{' + type),
                extraOpen = 0,
                blockTemplate = '';

            // Jump ahead through the template to find the block's closing tag,
            // which will be an {/if} or {/each}.
            // This is because we must put a properly labeled comment at the end the block.
            // <!--{/if}---> or <!--{/each}-->
            // Also we must copy the block's section of the template,
            // from beginning to end, and put it in the block's opening comment.
            for (let j = (i + 2); j < (template.length - 1); j += 2) {

                let section2 = template[j];

                if (extraOpening.test(section2)) { extraOpen++; }
                else if (blockClosing === section2) {

                    if (0 === extraOpen) {

                        if ('if' === type) {
                            blockTemplate = template.slice( i, (j + 1) );
                        } else {
                            blockTemplate = template.slice( (i + 1), j );
                        }

                        blockTemplate = blockTemplate.join('');

                        // Escape dollar signs before interpolation
                        blockTemplate = blockTemplate.replace('${', '\\${');

                        // Escape user comments
                        blockTemplate = blockTemplate.replace('<!--', '<\\\\!--');
                        blockTemplate = blockTemplate.replace('-->', '--\\\\>');

                        blockTemplate = '\n' + blockTemplate + '\n';

                        let end = '';


                        //
                        // Translate the template's block closing
                        // to JavaScript and HTML comments
                        //

                        // An each-loop also needs the closing tag for its last item
                        if ('each' === type) { end += "yield '<!--{/item}-->';"; }

                        // block closing
                        end += "} yield '<!--{/" + type + "}-->';";

                        template[j] = end;

                        // Now that we are done finding and translating the end,
                        // as well as filling out the blockTemplate variable,
                        // used in the opening block comment,
                        // we can break out of this inner for-loop,
                        // to go back to translating the block's opening
                        break;
                    } else {
                        extraOpen--;
                    }
                }

            }

            // Translate the template's block opening
            // to JavaScript and HTML comments
            switch (type) {
                case 'if':
                    section = section.replace(
                        regExps.ifOpening,
                        "yield `<!--{if $1" + blockTemplate + "}-->`; " +
                        '\nif ($1) {\n'
                    );
                    break;

                case 'each':
                    section = section.replace(
                        regExps.eachOpening,
                        "yield `<!--{each $1 $3" + blockTemplate + "}-->`; " +
                        '\nfor (let $3 of $1) {\n' +
                        "yield '<!--{item}-->';"
                    );
                    break;
            }
        }

        template[i] = section;
    }


    //
    // Translate variable interpolations
    // in text nodes and element attributes
    //

    for (let i = 0; i < template.length; i += 2) {

        let section = template[i];

        if ('' !== section) {
            // Translate attribute variables
            section = section.replace(regExps.element, function (match) {
                let attrs = match.match(regExps.attrKey);
                if (attrs) {
                    let attrMap = {};
                    for (let a of attrs) {
                        a = a.split('=');
                        let attr = a[0],
                            key = a[1].replace(regExps.attrVal, '$1');

                        if (! (key in attrMap)) { attrMap[key] = []; }
                        attrMap[key].push(attr);
                    }

                    let attrList = [];

                    for (let key in attrMap) {
                        attrList.push([ attrMap[key].join(','), key ].join('='));
                    }

                    attrList = attrList.join(' ');

                    let comment = `<!--{attr ${attrList}}-->`;

                    // Erase attribute value for now,
                    // so that text interpolation, later, will not match it.
                    // The attribute will be filled in later, from the comment.
                    match = match.replace(regExps.attrVal, '""');
                    match = comment + match;
                }

                return match;
            });

            // Replace textual interpolations with comment nodes,
            // to be filled in at the end, from the data in the comment
            section = section.replace(regExps.interpolation, '<!--{text $1}--><!--{/text}-->');
            section = 'yield `' + section + '`;';
        }

        template[i] = section;
    }

    template = template.join('\n');
    let head = importAliases(env);
    template = '"use strict;"' + '\n\n' + head + '\n\n' + template;
    let g = new GeneratorFunction(template);

    // Wrap Generator Function in another function,
    // which will loop through it, gathering all of the yielded content,
    // and joining them together into one string.
    let f = function(val) {
        let tpl = g(val);
        tpl = [ ...tpl ].join('');
        return tpl;
    }

    return f;
}

// A quirky interaction between:
//
// (1) the browser's automatic insertion of a tbody element if none
// (2) this libary's usage of comment nodes
//
// can lead to the comment nodes ending up in the wrong place.
//
//
// A perfectly reasonable template like this:
//
//      <table>
//      {each list as item}
//          <tr>
//              <td>{item.name}</td>
//              <td>{item.date}</td>
//          </tr>
//      {/each}
//      </table>
//
// at first is transformed by the library into this:
//
//      <table>
//          <!--{each list item ...}-->
//          <tr>
//              <td><!--{text item.name}--><!--{/text}--></td>
//              <td><!--{text item.date}--><!--{/text}--></td>
//          </tr>
//          <!--{/each}-->
//      </table>
//
// but then becomes, with the browser's auto-insertion:
//
//      <table>
//          <!--{each list item ...}-->
//          <tbody>
//              <tr>
//                  <td><!--{text item.name}--><!--{/text}--></td>
//                  <td><!--{text item.date}--><!--{/text}--></td>
//              </tr>
//              <!--{/each}-->
//          </tbody>
//      </table>
//
// instead of:
//
//      <table>
//          <tbody>
//              <!--{each list item ...}-->
//              <tr>
//                  <td><!--{text item.name}--><!--{/text}--></td>
//                  <td><!--{text item.date}--><!--{/text}--></td>
//              </tr>
//              <!--{/each}-->
//          </tbody>
//      </table>
//
// This function fixes that.
//
// It looks for this set of circumstances:
//
// - a table has just one tBody, and
// - the tBody has at least one block-level tracking comment before it, and
// - it has none after it
//
// In such a case, it moves all comment nodes that were before the tBody
// to just inside it, at its beginning.
function fixTables(frag) {

    // Is the node an opening comment used for tracking,
    // specifically a block-level piece (if, each, or item),
    // not a text or an attribute?
    function openingTracks(node) {
        let blockRegExp = /^{(if|each|item)/;
        const r = (
            (Node.COMMENT_NODE === node.nodeType) &&
            blockRegExp.test(node.nodeValue)
        );
        return r;
    }

    // Is the node a comment used to close a block?
    function closingTracks(node) {
        let blockRegExp = /^{\/(if|each|item)/;
        const r = (
            (Node.COMMENT_NODE === node.nodeType) &&
            blockRegExp.test(node.nodeValue)
        );
        return r;
    }

    // Have we reached a node that shows we can stop traversal?
    function ends(node) {
        const r = (
            (null === node) ||
            (Node.ELEMENT_NODE === node.nodeType)
        );
        return r;
    }

    const tables = frag.querySelectorAll('table');

    for (const table of tables) {
        if (1 === table.tBodies.length) {
            const tBody = table.tBodies[0];
            let tracksBefore = false;
            for (let node = tBody.previousSibling; ! ends(node); node = node.previousSibling) {
                tracksBefore = openingTracks(node);
                if (tracksBefore) { break; }
            }
            if (tracksBefore) {
                let tracksAfter = false;
                for (let node = tBody.nextSibling; ! ends(node); node = node.nextSibling) {
                    tracksAfter = closingTracks(node);
                    if (tracksAfter) { break; }
                }
                if (! tracksAfter) {
                    while (! ends(tBody.previousSibling)) {
                        tBody.prepend(tBody.previousSibling);
                    }
                }
            }
        }
    }
}

function htmlToFrag(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    fixTables(tpl.content);
    return tpl.content;
}

// Make inline functions asynchronous, so that user can use "await".
// Import variables from context and each-loops.
function augmentInlineFunctions(element, env) {

    let aliasImport = importAliases(env),
        aliasExport = exportAliases(env);

    for (let a of element.getAttributeNames()) {
        if (a.startsWith('on')) {
            let funcBody = element.getAttribute(a);
            funcBody = funcBody.replace(regExps.funcAug, '');
            funcBody = funcBody.trimEnd();
            if (! funcBody.endsWith(';')) { funcBody += ';'; }
            funcBody =
                funcCommentStart +
                '"use strict";\n' +
                '(async () => {\n' +
                    aliasImport +
                    funcCommentEnd +
                    funcBody +
                    funcCommentStart +
                    aliasExport +
                '\n})();' +
                funcCommentEnd;
            element.setAttribute(a, funcBody);
        }
    }
}

// The index of data keys to nodes in the body
const Masonry = {

    index: {},

    get(key) {

        let masons = this.index[ key ];
        if (undefined === masons) { masons = []; }
        else { masons = [ ...masons ]; }

        return masons;
    },

    add(mason) {

        const masons = this.get(mason.path),
              path = mason.path;

        delete mason.path;

        if (0 === masons.length) {
            this.index[ path ] = [ mason ];
        } else {
            let add = true;
            for (let oldMason of masons) {
                if (oldMason.firstNode === mason.firstNode) {
                    // already indexed
                    add = false;
                    break;
                }
            }
            if (add) { this.index[ path ].push(mason); }
        }
    },

    handleComment(comment, env) {

        const mason = {};

        let content = comment.nodeValue.match(regExps.comment);
        if (! content) { return; }

        content = content[1].trim().split('\n');

        if (1 < content.length) {
            mason.template = content.slice(1).join('\n');
        }

        // Comment's data is separated by spaces
        content = content[0].split(' ');
        mason.type = content[0];

        switch (mason.type) {

            case 'attr':

                //  <!--{attr attr1=var1 attr2,attr3=var2}--><element...>
                {
                    let assignments = content.slice(1);

                    for (let assignment of assignments) {
                        assignment = assignment.split('=');

                        let attrs = assignment[0].split(','),
                            path = assignment[1],
                            attrMason = Object.assign({}, mason);

                        attrMason.path = getFullPath(path, env);

                        // The HTML element is right after the comment node
                        attrMason.firstNode = comment.nextSibling;
                        attrMason.attrs = attrs;
                        attrMason.update = function (val) {
                            if ([ false, null, undefined ].includes(val)) {
                                for (let attr of this.attrs) {
                                    this.firstNode.removeAttribute(attr);
                                }
                            } else {
                                for (let attr of this.attrs) {
                                    // Because of how boolean HTML attributes work,
                                    // first try finding it as a JavaScript property,
                                    // to set it as true or false.
                                    // Otherwise the mere presence of a boolean
                                    // HTML attribute gets interpreted as true.
                                    if (attr in this.firstNode) { this.firstNode[attr] = val; }
                                    else { this.firstNode.setAttribute(attr, val); }
                                }
                            }
                        };

                        let val = getValueByPath(window, attrMason.path);
                        attrMason.update(val);
                        this.add(attrMason);
                    }
                }

                break;


            case 'text':

                //  <!--{text var}-->value<!--{/text}-->
                {
                    mason.path = getFullPath(content[1], env);
                    mason.firstNode = comment;
                    mason.update = function (val) {

                        switch (this.firstNode.nextSibling.nodeType) {

                            case Node.TEXT_NODE:

                                if (null == val) {
                                    this.firstNode.nextSibling.remove();
                                } else {
                                    this.firstNode.nextSibling.nodeValue = val;
                                }

                                break;

                            case Node.COMMENT_NODE:

                                let text = document.createTextNode(val);
                                this.firstNode.after(text);

                                break;
                        }
                    };

                    let val = getValueByPath(window, mason.path);
                    mason.update(val);
                    this.add(mason);
                }

                break;


            case 'if':

                //  <!--{if var
                //  template
                //  }-->

                {
                    mason.firstNode = comment;
                    mason.path = getFullPath(content[1], env);
                    mason.aliases = [ ...env.aliases ];
                    let updateTemplateFunc = templateToFunction(mason.template, env);
                    mason.update = function (val) {

                        let html = updateTemplateFunc(),
                            frag = htmlToFrag(html);

                        frag.firstChild.remove();
                        frag.lastChild.remove();

                        let subEnv = {
                            aliases: this.aliases,
                            dataVal: env.dataVal,
                            dataKey: env.dataKey
                        };

                        Masonry.scan(frag.firstChild, frag.lastChild, subEnv);
                        deleteNodesBetween(this.firstNode, this.lastNode);
                        this.firstNode.after(frag);
                    };

                    env.openBlocks.push(mason);
                }

                break;


            case '/if':

                {
                    let mason = env.openBlocks.pop();
                    mason.lastNode = comment;
                    this.add(mason);
                }

                break;


            case 'each':

                //  <!--{each array alias
                //  template
                //  }-->
                {
                    mason.alias = content[2];
                    mason.array = content[1];
                    mason.index = 0;
                    mason.firstNode = comment;
                    mason.path = getFullPath(mason.array, env);
                    mason.aliases = [ ...env.aliases ];
                    env.openBlocks.push(mason);
                    env.openLoops.push(mason);
                }

                break;


            case '/each':

                {
                    let mason = env.openBlocks.pop(),
                        loop = env.openLoops.pop(),
                        template =
                            '{each ' + loop.array + ' as ' + loop.alias + '}' +
                                mason.template +
                            '{/each}';

                    mason.lastNode = comment;

                    let updateTemplateFunc = templateToFunction(template, env);
                    mason.update = function(val) {

                        let html = updateTemplateFunc(),
                            frag = htmlToFrag(html);

                        frag.firstChild.remove();
                        frag.lastChild.remove();

                        // Reset index to 0,
                        // since the last scan set to length + 1,
                        // for the append function
                        this.index = 0;

                        let subEnv = {
                            aliases: this.aliases,
                            dataVal: env.dataVal,
                            dataKey: env.dataKey,
                            openLoops: [ this ]
                        };

                        Masonry.scan(frag.firstChild, frag.lastChild, subEnv);
                        deleteNodesBetween(this.firstNode, this.lastNode);
                        this.firstNode.after(frag);
                    };


                    // each-blocks have not only an update function
                    // but also an append function
                    let appendingEnv = Object.assign({}, env),
                        aliases = [ ...env.aliases ],
                        path = loop.array + '[ ' + loop.array + '.length - 1 ]';

                    aliases.push([ loop.alias, path ]);
                    appendingEnv.aliases = aliases;

                    let appendTemplateFunc = templateToFunction(loop.template, appendingEnv);

                    mason.append = function (val) {

                        let html = appendTemplateFunc();
                        html = `<!--{item}-->${html}<!--{/item}-->`;

                        let frag = htmlToFrag(html);

                        let subEnv = {
                            aliases: mason.aliases,
                            dataVal: env.dataVal,
                            dataKey: env.dataKey,
                            openLoops: [ this ]
                        };

                        Masonry.scan(frag.firstChild, frag.lastChild, subEnv);
                        this.lastNode.before(frag);
                    };

                    this.add(mason);
                }

                break;


            case 'item':

                {
                    let loop = env.openLoops.at(-1);
                    if (! loop) { break; }
                    let path = loop.array + '[' + loop.index + ']';
                    env.aliases.push([ loop.alias, path ]);
                    mason.path = getFullPath(path, env);
                    mason.firstNode = comment;
                    mason.aliases = [ ...env.aliases ];
                    let template = templateToFunction(loop.template, env);
                    mason.update = function (val) {

                        // If just a string, a text node within it will take care of that.
                        // But if an object, need to rerender whole item.
                        if (isObject(val)) {
                            let html = template(),
                                frag = htmlToFrag(html);

                            let subEnv = {
                                aliases: this.aliases,
                                dataVal: env.dataVal,
                                dataKey: env.dataKey
                            };

                            Masonry.scan(frag.firstChild, frag.lastChild, subEnv);
                            deleteNodesBetween(this.firstNode, this.lastNode);
                            this.firstNode.after(frag);

                        } else if (undefined === val) {
                            // Delete item, including surrounding comment nodes
                            deleteNodesBetween(
                                this.firstNode.previousSibling,
                                this.lastNode.nextSibling
                            );
                        }
                    };
                    env.openBlocks.push(mason);
                }

                break;


            case '/item':

                {
                    if (0 === env.openLoops.length) { break; }
                    env.aliases.pop();
                    env.openLoops.at(-1).index++;
                    let mason = env.openBlocks.pop();
                    mason.lastNode = comment;
                    this.add(mason);
                }

                break;
        }
    },

    handleElement(element, env) {
        augmentInlineFunctions(element, env);
        if (0 !== element.childNodes.length) {
            this.scan(element.firstChild, element.lastChild, env);
        }
    },

    scan(firstNode, lastNode, env = {}) {

        if (! (firstNode && lastNode)) { return; }
        let env0 = { aliases: [], openBlocks: [], openLoops: [] };
        env = Object.assign(env0, env);

        for (
            let node = firstNode;
            node !== lastNode.nextSibling;
            node = node.nextSibling
        ) {
            switch (node.nodeType) {
                case Node.COMMENT_NODE:
                    this.handleComment(node, env);
                    break;
                case Node.ELEMENT_NODE:
                    this.handleElement(node, env);
                    break;
            }
        }
    },

    // Remove from the index any masons removed from the DOM
    sweep() {
        for (let path in this.index) {
            let masons = this.index[ path ].filter((mason) => {
                return mason.firstNode.isConnected;
            });

            // If all of a key's pieces are gone,
            // then also remove the path from the index
            if (0 === masons.length) { delete this.index[ path ]; }
            else { this.index[ path ] = masons; }
        }
    },

    reindexLoop(path) {

        // Remove old entries from index for path and its subpaths

        const prefix = path + '[';

        for (let key in this.index) {
            if (key.startsWith(prefix)) {
                delete this.index[ key ];
            }
        }

        const [ dataKey, dataVal ] = getDataSource(path),
              masons = this.get(path);

        delete this.index[ path ];

        for (let mason of masons) {
            const env = {
                aliases: mason.aliases,
                dataKey: dataKey,
                dataVal: dataVal
            };
            this.scan(mason.firstNode, mason.lastNode, env);
        }
    },

    replaceObject(path, obj) {

        let prefix = path + '.';

        for (let key in this.index) {
            if (key === path) {
                this.update(key, obj);
            } else if (key.startsWith(prefix)) {
                let rest = key.substr(prefix.length),
                    val = getValueByPath(obj, rest);
                this.update(key, val);
            }
        }
    },

    append(key, val) {
        const masons = this.get(key);
        for (let mason of masons) { mason.append(val); }
    },

    update(key, val) {
        const masons = this.get(key);
        for (let mason of masons) {
            if (mason.firstNode.isConnected) { mason.update(val); }
        }
        this.sweep();
    }
};

function checkGetters(path) {

    let [ dataKey, dataVal ] = getDataSource(path),
        prefix = dataKey + '.';

    let paths = Object.keys(getters).filter((v) => {
        return v.startsWith(prefix);
    });

    for (let path of paths) {
        let subpath = path.slice(prefix.length),
            subval = getValueByPath(dataVal, subpath);

        if (undefined === subval) {
            delete getters[ path ];
        } else {
            let entry = getters[ path ],
                newVal = entry.obj[ entry.key ],
                newCache = getCacheValue(newVal);

            if (entry.val !== newCache) {
                entry.val = newCache;
                Masonry.update(path, newVal);
            }
        }
    }
}

function reindexArrayElements(arr, prefix) {
    for (let i = 0; i < arr.length; i++) {

        let val = arr[ i ];

        if (canProxy(val)) {
            let path = makePath(prefix, i);
            proxyMap.set(val, path);
            if (Array.isArray(val)) { reindexArrayElements(val, path); }
            else { reindexObjectProperties(val, path); }
        }
    }
}

function reindexObjectProperties(obj, prefix) {
    for (let entry of Object.entries(obj)) {

        let key = entry[0],
            val = entry[1],
            path = makePath(prefix, key),
            oldPath = proxyMap.get(val);

        if (oldPath in getters) {
            let getter = getters[ oldPath ];
            delete getters[ oldPath ];
            getters[ path ] = getter;
        } else if (canProxy(val)) {
            proxyMap.set(val, path);
            if (Array.isArray(val)) { reindexArrayElements(val, path); }
            else { reindexObjectProperties(val, path); }
        }
    }
}

function makeProxy(obj, prefix) {

    let proxy = new Proxy(obj, {

        deleteProperty: (target, key) => {
            if (! isWritable(target, key)) { return false; }
            let prefix = proxyMap.get(proxy),
                path = makePath(prefix, key);
            if (Array.isArray(target)) { target.splice(key, 1); }
            else { delete target[key]; }
            Masonry.update(path, undefined);
            return true;
        },

        set: (target, key, val) => {

            const actions = { update: 1, append: 2 };

            let action,
                path,
                prefix = proxyMap.get(proxy),
                hasKey = (key in target),
                writable = true;

            if (hasKey) {
                writable = isWritable(target, key);
                if (writable && (val !== target[key])) {
                    action = actions.update;
                    path = makePath(prefix, key);
                }
            } else if (Array.isArray(target)) {
                action = actions.append,
                path = prefix;
            }

            if (action) {
                if (
                    // Deleting an item of an array
                    (actions.update === action) &&
                    (undefined === val) &&
                    Array.isArray(target)
                ) {
                    target.splice(key, 1);
                    Masonry.update(path, val);
                    Masonry.reindexLoop(prefix);
                    reindexArrayElements(target, prefix);
                } else {

                    if (canProxy(val)) {
                        let prefix = path;
                        if (actions.append === action) {
                            prefix += '[' + target.length + ']';
                        }
                        val = makeProxy(val, prefix);
                    }

                    const wasObject = isObject(target[key]);

                    target[key] = val;

                    if (wasObject) {
                        Masonry.replaceObject(path, val);
                    } else if (actions.append === action) {
                        Masonry.append(path, val);
                    } else {
                        Masonry.update(path, val);
                    }
                }

                checkGetters(path);
            }

            return writable;
        }
    });

    proxyMap.set(proxy, prefix);

    for (let entry of Object.entries(proxy)) {

        let key = entry[0],
            val = entry[1],
            path = makePath(prefix, key);

        // Track any properties that are getters,
        // merely computed from the values of other properties,
        // instead of changed directly.
        //
        // JavaScript's Proxy object naturally will not tell you
        // when the value of one of these getters changes.
        // So each time any property on the object changes,
        // we will check each getter to see if it also has changed,
        // and then trigger an update on any dependent nodes.
        if (isAGetter(obj, key)) {
            getters[path] = {
                obj: obj,
                key: key,
                val: getCacheValue(val)
            };
        } else if (canProxy(val)) {
            obj[key] = makeProxy(val, path);
        }
    }

    return proxy;
}

const dataKeyObserverConfig = { attributes: true };
const dataKeyObserver = new MutationObserver((mutations, observer) => {
    for (const mutation of mutations) {
        if ('data-key' === mutation.attributeName) {

            let template;

            for (let t of templates) {
                if (mutation.target === t.element) {
                    template = t;
                }
            }

            renderTemplate(template);
        }
    }
});

function setUpTemplate(template) {

    let content = template.innerHTML;
    content = splitElifBlocks(content);

    const comment = document.createComment('{/template}');
    template.after(comment);

    template = {
        element: template,
        content: content,
        comment: comment
    };

    templates.push(template);
    dataKeyObserver.observe(template.element, dataKeyObserverConfig);
    renderTemplate(template);
}

function renderTemplate(template) {

    deleteNodesBetween(template.element, template.comment);
    const dataKey = template.element.dataset.key;

    if (! dataKey) { return; }

    const dataVal = getDataVal(dataKey),
          env = {
              dataKey: dataKey,
              dataVal: dataVal,
              aliases: []
          },
          templateFunc = templateToFunction(template.content, env),
          html = templateFunc(),
          frag = htmlToFrag(html);

    Masonry.scan(frag.firstChild, frag.lastChild, env);
    template.element.after(frag);
}

function getDataVal(dataKey) {
    let dataVal = getValueByPath(window, dataKey);

    // If value is unregistered or has changed
    if (dataVal !== dataKeys[ dataKey ]) {
        dataVal = makeProxy(dataVal, dataKey);
        dataKeys[ dataKey ] = dataVal;
        setValueByPath(window, dataKey, dataVal);
    }

    return dataVal;
}

document.addEventListener('DOMContentLoaded', () => {
    const els = document.querySelectorAll(templateSelector);
    for (const el of els) {
        setUpTemplate(el);
    }
});

}
