module.exports = (function () {
"use strict";
var Match;
var _ = require("underscore");
var EJSON = require("ejson");

// Sets child's prototype to a new object whose prototype is parent's
// prototype. Used as:
//   Meteor._inherits(ClassB, ClassA).
//   _.extend(ClassB.prototype, { ... })
// Inspired by CoffeeScript's `extend` and Google Closure's `goog.inherits`.
function _inherits(Child, Parent) {
  // copy Parent static properties
  for (var key in Parent) {
    // make sure we only copy hasOwnProperty properties vs. prototype
    // properties
    if (_.has(Parent, key))
      Child[key] = Parent[key];
  }

  // a middle member of prototype chain: takes the prototype from the Parent
  var Middle = function () {
    this.constructor = Child;
  };
  Middle.prototype = Parent.prototype;
  Child.prototype = new Middle();
  Child.__super__ = Parent.prototype;
  return Child;
}

// Makes an error subclass which properly contains a stack trace in most
// environments. constructor can set fields on `this` (and should probably set
// `message`, which is what gets displayed at the top of a stack trace).
//
function makeErrorType(name, constructor) {
  var errorClass = function (/*arguments*/) {
    var self = this;

    // Ensure we get a proper stack trace in most Javascript environments
    if (Error.captureStackTrace) {
      // V8 environments (Chrome and Node.js)
      Error.captureStackTrace(self, errorClass);
    } else {
      // Firefox
      var e = new Error;
      e.__proto__ = errorClass.prototype;
      if (e instanceof errorClass)
        self = e;
    }
    // Safari magically works.

    constructor.apply(self, arguments);

    self.errorType = name;

    return self;
  };

  _inherits(errorClass, Error);

  return errorClass;
};

// XXX docs

// Things we explicitly do NOT support:
//    - heterogenous arrays
  
function formatKey(key) {
  if (/^[$_a-zA-Z][$_a-zA-Z0-9]*$/.test(key)) return key;
  return "'" + key + "'";
}

/**
 * @namespace Match
 * @summary The namespace for all Match types and methods.
 */
Match = {
  Optional: function (pattern) {
    return new Optional(pattern);
  },
  OneOf: function (/*arguments*/) {
    return new OneOf(_.toArray(arguments));
  },
  Any: ['__any__'],
  Where: function (condition, name) {
    return new Where(condition, name);
  },
  ObjectIncluding: function (pattern) {
    return new ObjectIncluding(pattern);
  },
  ObjectWithValues: function (pattern) {
    return new ObjectWithValues(pattern);
  },
  // Matches only signed 32-bit integers
  Integer: ['__integer__'],

  // XXX matchers should know how to describe themselves for errors
  Error: makeErrorType("Match.Error", function (msg) {
    this.message = "Match error: " + msg;
    // The path of the value that failed to match. Initially empty, this gets
    // populated by catching and rethrowing the exception as it goes back up the
    // stack.
    // E.g.: "vals[3].entity.created"
    this.path = "";
  }),

  // Tests to see if value matches pattern. Unlike check, it merely returns true
  // or false (unless an error other than Match.Error was thrown). It does not
  // interact with _failIfArgumentsAreNotAllChecked.
  // XXX maybe also implement a Match.match which returns more information about
  //     failures but without using exception handling or doing what check()
  //     does with _failIfArgumentsAreNotAllChecked and Meteor.Error conversion

  /**
   * @summary Returns true if the value matches the pattern.
   * @locus Anywhere
   * @param {Any} value The value to check
   * @param {MatchPattern} pattern The pattern to match `value` against
   */
  test: function (value, pattern) {
    try {
      checkSubtree(value, pattern);
      return true;
    } catch (e) {
      if (e instanceof Match.Error)
        return false;
      // Rethrow other errors.
      throw e;
    }
  },
};

var Optional = function (pattern) {
  this.pattern = pattern;
};
Optional.prototype.__formatPattern = function __formatPattern(formatPattern) {
  return '?' + formatPattern(this.pattern);
};

var OneOf = function (choices) {
  if (_.isEmpty(choices))
    throw new Error("Must provide at least one choice to Match.OneOf");
  this.choices = choices;
};
OneOf.prototype.__formatPattern = function __formatPattern(formatPattern) {
  return this.choices.map(function (choice) {
    return formatPattern(choice);
  }).join(' | ');
};

var Where = function (condition, name) {
  this.condition = condition;
  this.name = name || "(custom condition)";
};
Where.prototype.__formatPattern = function __formatPattern() {
  return this.name;
};

var ObjectIncluding = function (pattern) {
  this.pattern = pattern;
};
ObjectIncluding.prototype.__formatPattern = function __formatPattern(formatPattern) {
  var pattern = this.pattern;
  return '{' + Object.keys(pattern).map(function (key) { 
    return formatKey(key) + ': ' + formatPattern(pattern[key]); 
  }) .join(', ') + '}';
};

var ObjectWithValues = function (pattern) {
  this.pattern = pattern;
};
ObjectWithValues.prototype.__formatPattern = function __formatPattern(formatPattern) {
  return '{[key: any]: ' + formatPattern(this.pattern) + '}'; 
};

var typeofChecks = [
  [String, "string"],
  [Number, "number"],
  [Boolean, "boolean"],
  // While we don't allow undefined in EJSON, this is good for optional
  // arguments with OneOf.
  [undefined, "undefined"]
];

function customize(options) {
  var fmtPattern = options && options.formatPattern || formatPattern;
  var fmtMismatch = options && options.formatMismatch || formatMismatch;
  var fmtMismatchForPath = options && options.formatMismatchForPath || formatMismatchForPath;

  /**
   * @summary Check that a value matches a [pattern](#matchpatterns).
   * If the value does not match the pattern, throw a `Match.Error`.
   *
   * Particularly useful to assert that arguments to a function have the right
   * types and structure.
   * @locus Anywhere
   * @param {Any} value The value to check
   * @param {MatchPattern} pattern The pattern to match
   * `value` against
   */
  var check = function (value, pattern) {
    try {
      checkSubtree(value, pattern);
    } catch (err) {
      if (err.hasOwnProperty('pattern')) {
        var pat = fmtPattern(err.pattern);
        if (err.hasOwnProperty('value')) {
          var val = EJSON.stringify(err.value);
          if (err.path) err.message = fmtMismatchForPath(err.path, pat, val);
          else err.message = fmtMismatch(pat, val);
        } else {
          if (err.path) err.message = fmtMismatchForPath(err.path, pat);
          else err.message = fmtMismatch(pat);
        }
      }
      else if ((err instanceof Match.Error) && err.path) {
        err.message += " in field " + err.path;
      }
      throw err;
    }
  };

  var checkSubtree = function (value, pattern) {
    var origPattern = pattern;
    var origValue = value;

    function mismatchError(value) {
      var result = new Match.Error('mismatch');
      result.pattern = origPattern;
      result.value = value || origValue;
      return result;
    }

    // Match anything!
    if (pattern === Match.Any) return;

    // Basic atomic types.
    // Do not match boxed objects (e.g. String, Boolean)
    for (var i = 0; i < typeofChecks.length; ++i) {
      if (pattern === typeofChecks[i][0]) {
        if (typeof value === typeofChecks[i][1]) return;
        throw mismatchError();
      }
    }
    if (pattern === null) {
      if (value === null) return;
      throw mismatchError();
    }

    // Strings, numbers, and booleans match literally. Goes well with Match.OneOf.
    if (typeof pattern === "string" || typeof pattern === "number" || typeof pattern === "boolean") {
      if (value === pattern) return;
      throw mismatchError();
    }

    // Match.Integer is special type encoded with array
    if (pattern === Match.Integer) {
      // There is no consistent and reliable way to check if variable is a 64-bit
      // integer. One of the popular solutions is to get reminder of division by 1
      // but this method fails on really large floats with big precision.
      // E.g.: 1.348192308491824e+23 % 1 === 0 in V8
      // Bitwise operators work consistantly but always cast variable to 32-bit
      // signed integer according to JavaScript specs.
      if (typeof value === "number" && (value | 0) === value) return;
      throw mismatchError();
    }

    // "Object" is shorthand for Match.ObjectIncluding({});
    if (pattern === Object)
      pattern = Match.ObjectIncluding({});

    // Array (checked AFTER Any, which is implemented as an Array).
    if (pattern instanceof Array) {
      if (pattern.length !== 1)
        throw Error("Bad pattern: arrays must have one type element" +
          EJSON.stringify(pattern));
      if (!_.isArray(value) && !_.isArguments(value)) throw mismatchError();

      _.each(value, function (valueElement, index) {
        try {
          checkSubtree(valueElement, pattern[0]);
        } catch (err) {
          if (err instanceof Match.Error) {
            err.path = _prependPath(index, err.path);
          }
          throw err;
        }
      });
      return;
    }

    // Arbitrary validation checks. The condition can return false or throw a
    // Match.Error (ie, it can internally use check()) to fail.
    if (pattern instanceof Where) {
      if (pattern.condition(value)) return;
      throw mismatchError();
    }


    if (pattern instanceof Optional)
      pattern = Match.OneOf(undefined, pattern.pattern);

    if (pattern instanceof OneOf) {
      for (var i = 0; i < pattern.choices.length; ++i) {
        try {
          checkSubtree(value, pattern.choices[i]);
          // No error? Yay, return.
          return;
        } catch (err) {
          // Other errors should be thrown. Match errors just mean try another
          // choice.
          if (!(err instanceof Match.Error)) throw err;
        }
      }
      throw mismatchError();
    }

    // A function that isn't something we special-case is assumed to be a
    // constructor.
    if (pattern instanceof Function) {
      if (value instanceof pattern) return;
      throw mismatchError();
    }

    var unknownKeysAllowed = false;
    var unknownKeyPattern;
    if (pattern instanceof ObjectIncluding) {
      unknownKeysAllowed = true;
      pattern = pattern.pattern;
    }
    if (pattern instanceof ObjectWithValues) {
      unknownKeysAllowed = true;
      unknownKeyPattern = [pattern.pattern];
      pattern = {};  // no required keys
    }

    if (typeof pattern !== "object")
      throw Error("Bad pattern: unknown pattern type");

    // An object, with required and optional keys. Note that this does NOT do
    // structural matches against objects of special types that happen to match
    // the pattern: this really needs to be a plain old {Object}!
    if (typeof value !== 'object') throw mismatchError();
    if (value === null) throw mismatchError();
    if (value.constructor !== Object) throw mismatchError();

    var requiredPatterns = {};
    var optionalPatterns = {};
    _.each(pattern, function (subPattern, key) {
      if (subPattern instanceof Optional) {
        optionalPatterns[key] = subPattern.pattern;
      } else {
        requiredPatterns[key] = subPattern;
      }
    });

    _.each(value, function (subValue, key) {
      try {
        if (_.has(requiredPatterns, key)) {
          checkSubtree(subValue, requiredPatterns[key]);
          delete requiredPatterns[key];
        } else if (_.has(optionalPatterns, key)) {
          checkSubtree(subValue, optionalPatterns[key]);
        } else {
          if (!unknownKeysAllowed)
            throw new Match.Error("Unknown key");
          if (unknownKeyPattern) {
            checkSubtree(subValue, unknownKeyPattern[0]);
          }
        }
      } catch (err) {
        if (err instanceof Match.Error) err.path = _prependPath(key, err.path);
        throw err;
      }
    });

    _.each(requiredPatterns, function (subPattern, key) {
      throw new Match.Error("Missing key '" + key + "'");
    });
  };

  return check;
}

function formatPattern(pattern) {
  if (pattern === Match.Any) return 'any';

  for (var i = 0; i < typeofChecks.length; i++) {
    if (pattern === typeofChecks[i][0]) return typeofChecks[i][1];
  }

  if (pattern === null) return 'null';

  // Strings, numbers, and booleans match literally. Goes well with Match.OneOf.
  if (typeof pattern === "string" || typeof pattern === "number" || typeof pattern === "boolean") return pattern;

  // Match.Integer is special type encoded with array
  if (pattern === Match.Integer) return 'integer';

  // "Object" is shorthand for Match.ObjectIncluding({});
  if (pattern === Object) return 'Object';

  // Array (checked AFTER Any, which is implemented as an Array).
  if (pattern instanceof Array) {
    if (pattern.length !== 1)
      throw Error("Bad pattern: arrays must have one type element" +
        EJSON.stringify(pattern));

    return 'Array<' + formatPattern(pattern[0]) + '>';
  }
  
  var proto = Object.getPrototypeOf(pattern)
  if (proto && proto.__formatPattern) return proto.__formatPattern(formatPattern);

  // A function that isn't something we special-case is assumed to be a
  // constructor.
  if (pattern instanceof Function) return pattern.name;

  if (typeof pattern !== "object")
    throw Error("Bad pattern: unknown pattern type");
  
  return '{| ' + Object.keys(pattern).map(function (key) {
    return formatKey(key) + ': ' + formatPattern(pattern[key]);
  }).join(', ') + ' |}';
}

function formatMismatch(expected, actual) {
  if (arguments.length === 2) return 'Expected ' + expected + ', got ' + actual;
  return 'Expected ' + expected;
}

function formatMismatchForPath(path, expected, actual) {
  if (arguments.length === 3) return path + ' must be a ' + expected + '; got ' + actual;
  return path + ' must be a ' + expected;
}

var _jsKeywords = ["do", "if", "in", "for", "let", "new", "try", "var", "case",
  "else", "enum", "eval", "false", "null", "this", "true", "void", "with",
  "break", "catch", "class", "const", "super", "throw", "while", "yield",
  "delete", "export", "import", "public", "return", "static", "switch",
  "typeof", "default", "extends", "finally", "package", "private", "continue",
  "debugger", "function", "arguments", "interface", "protected", "implements",
  "instanceof"];

// Assumes the base of path is already escaped properly
// returns key + base
var _prependPath = function (key, base) {
  if ((typeof key) === "number" || key.match(/^[0-9]+$/))
    key = "[" + key + "]";
  else if (!key.match(/^[a-z_$][0-9a-z_$]*$/i) || _.contains(_jsKeywords, key))
    key = JSON.stringify([key]);

  if (base && base[0] !== "[")
    return key + '.' + base;
  return key + base;
};

  return { customize: customize, check: customize(), Match: Match};
}).call(this);