module.exports =
/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};

/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {

/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;

/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			exports: {},
/******/ 			id: moduleId,
/******/ 			loaded: false
/******/ 		};

/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);

/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;

/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}


/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;

/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;

/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "/build/";

/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var winston = __webpack_require__(1);
	var async = __webpack_require__(2);
	var moment = __webpack_require__(3);
	var useragent = __webpack_require__(4);
	var express = __webpack_require__(5);
	var Webtask = __webpack_require__(6);
	var app = express();
	var Request = __webpack_require__(9);
	var memoizer = __webpack_require__(10);

	__webpack_require__(15).Papertrail;

	function lastLogCheckpoint(req, res) {
	  var ctx = req.webtaskContext;
	  var required_settings = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'PAPERTRAIL_HOST', 'PAPERTRAIL_PORT'];
	  var missing_settings = required_settings.filter(function (setting) {
	    return !ctx.data[setting];
	  });

	  if (missing_settings.length) {
	    return res.status(400).send({ message: 'Missing settings: ' + missing_settings.join(', ') });
	  }

	  // If this is a scheduled task, we'll get the last log checkpoint from the previous run and continue from there.
	  req.webtaskContext.storage.get(function (err, data) {
	    var startCheckpointId = typeof data === 'undefined' ? null : data.checkpointId;

	    var logger = new winston.Logger({
	      transports: [new winston.transports.Papertrail({
	        host: ctx.data.PAPERTRAIL_HOST,
	        port: ctx.data.PAPERTRAIL_PORT,
	        hostname: ctx.data.PAPERTRAIL_SYSTEM || 'auth0-logs'
	      })]
	    });

	    // Start the process.
	    async.waterfall([function (callback) {
	      var getLogs = function getLogs(context) {
	        console.log('Logs from: ' + (context.checkpointId || 'Start') + '.');

	        var take = Number.parseInt(ctx.data.BATCH_SIZE);

	        take = take > 100 ? 100 : take;

	        context.logs = context.logs || [];

	        getLogsFromAuth0(req.webtaskContext.data.AUTH0_DOMAIN, req.access_token, take, context.checkpointId, function (logs, err) {
	          if (err) {
	            console.log('Error getting logs from Auth0', err);
	            return callback(err);
	          }

	          if (logs && logs.length) {
	            logs.forEach(function (l) {
	              return context.logs.push(l);
	            });
	            context.checkpointId = context.logs[context.logs.length - 1]._id;
	          }

	          console.log('Total logs: ' + context.logs.length + '.');
	          return callback(null, context);
	        });
	      };

	      getLogs({ checkpointId: startCheckpointId });
	    }, function (context, callback) {
	      var min_log_level = parseInt(ctx.data.LOG_LEVEL) || 0;
	      var log_matches_level = function log_matches_level(log) {
	        if (logTypes[log.type]) {
	          return logTypes[log.type].level >= min_log_level;
	        }
	        return true;
	      };

	      var types_filter = ctx.data.LOG_TYPES && ctx.data.LOG_TYPES.split(',') || [];
	      var log_matches_types = function log_matches_types(log) {
	        if (!types_filter || !types_filter.length) return true;
	        return log.type && types_filter.indexOf(log.type) >= 0;
	      };

	      context.logs = context.logs.filter(function (l) {
	        return l.type !== 'sapi' && l.type !== 'fapi';
	      }).filter(log_matches_level).filter(log_matches_types);

	      callback(null, context);
	    }, function (context, callback) {
	      console.log('Uploading blobs...');

	      async.eachLimit(context.logs, 5, function (log, cb) {
	        var date = moment(log.date);
	        var url = date.format('YYYY/MM/DD') + '/' + date.format('HH') + '/' + log._id + '.json';
	        console.log('Uploading ' + url + '.');

	        // papertrail here...
	        logger.info(JSON.stringify(log), cb);
	      }, function (err) {
	        if (err) {
	          return callback(err);
	        }

	        console.log('Upload complete.');
	        return callback(null, context);
	      });
	    }], function (err, context) {
	      if (err) {
	        console.log('Job failed.');

	        return req.webtaskContext.storage.set({ checkpointId: startCheckpointId }, { force: 1 }, function (error) {
	          if (error) {
	            console.log('Error storing startCheckpoint', error);
	            return res.status(500).send({ error: error });
	          }

	          res.status(500).send({
	            error: err
	          });
	        });
	      }

	      console.log('Job complete.');

	      return req.webtaskContext.storage.set({
	        checkpointId: context.checkpointId,
	        totalLogsProcessed: context.logs.length
	      }, { force: 1 }, function (error) {
	        if (error) {
	          console.log('Error storing checkpoint', error);
	          return res.status(500).send({ error: error });
	        }

	        res.sendStatus(200);
	      });
	    });
	  });
	}

	var logTypes = {
	  's': {
	    event: 'Success Login',
	    level: 1 // Info
	  },
	  'seacft': {
	    event: 'Success Exchange',
	    level: 1 // Info
	  },
	  'feacft': {
	    event: 'Failed Exchange',
	    level: 3 // Error
	  },
	  'f': {
	    event: 'Failed Login',
	    level: 3 // Error
	  },
	  'w': {
	    event: 'Warnings During Login',
	    level: 2 // Warning
	  },
	  'du': {
	    event: 'Deleted User',
	    level: 1 // Info
	  },
	  'fu': {
	    event: 'Failed Login (invalid email/username)',
	    level: 3 // Error
	  },
	  'fp': {
	    event: 'Failed Login (wrong password)',
	    level: 3 // Error
	  },
	  'fc': {
	    event: 'Failed by Connector',
	    level: 3 // Error
	  },
	  'fco': {
	    event: 'Failed by CORS',
	    level: 3 // Error
	  },
	  'con': {
	    event: 'Connector Online',
	    level: 1 // Info
	  },
	  'coff': {
	    event: 'Connector Offline',
	    level: 3 // Error
	  },
	  'fcpro': {
	    event: 'Failed Connector Provisioning',
	    level: 4 // Critical
	  },
	  'ss': {
	    event: 'Success Signup',
	    level: 1 // Info
	  },
	  'fs': {
	    event: 'Failed Signup',
	    level: 3 // Error
	  },
	  'cs': {
	    event: 'Code Sent',
	    level: 0 // Debug
	  },
	  'cls': {
	    event: 'Code/Link Sent',
	    level: 0 // Debug
	  },
	  'sv': {
	    event: 'Success Verification Email',
	    level: 0 // Debug
	  },
	  'fv': {
	    event: 'Failed Verification Email',
	    level: 0 // Debug
	  },
	  'scp': {
	    event: 'Success Change Password',
	    level: 1 // Info
	  },
	  'fcp': {
	    event: 'Failed Change Password',
	    level: 3 // Error
	  },
	  'sce': {
	    event: 'Success Change Email',
	    level: 1 // Info
	  },
	  'fce': {
	    event: 'Failed Change Email',
	    level: 3 // Error
	  },
	  'scu': {
	    event: 'Success Change Username',
	    level: 1 // Info
	  },
	  'fcu': {
	    event: 'Failed Change Username',
	    level: 3 // Error
	  },
	  'scpn': {
	    event: 'Success Change Phone Number',
	    level: 1 // Info
	  },
	  'fcpn': {
	    event: 'Failed Change Phone Number',
	    level: 3 // Error
	  },
	  'svr': {
	    event: 'Success Verification Email Request',
	    level: 0 // Debug
	  },
	  'fvr': {
	    event: 'Failed Verification Email Request',
	    level: 3 // Error
	  },
	  'scpr': {
	    event: 'Success Change Password Request',
	    level: 0 // Debug
	  },
	  'fcpr': {
	    event: 'Failed Change Password Request',
	    level: 3 // Error
	  },
	  'fn': {
	    event: 'Failed Sending Notification',
	    level: 3 // Error
	  },
	  'sapi': {
	    event: 'API Operation'
	  },
	  'fapi': {
	    event: 'Failed API Operation'
	  },
	  'limit_wc': {
	    event: 'Blocked Account',
	    level: 4 // Critical
	  },
	  'limit_ui': {
	    event: 'Too Many Calls to /userinfo',
	    level: 4 // Critical
	  },
	  'api_limit': {
	    event: 'Rate Limit On API',
	    level: 4 // Critical
	  },
	  'sdu': {
	    event: 'Successful User Deletion',
	    level: 1 // Info
	  },
	  'fdu': {
	    event: 'Failed User Deletion',
	    level: 3 // Error
	  }
	};

	function getLogsFromAuth0(domain, token, take, from, cb) {
	  var url = 'https://' + domain + '/api/v2/logs';

	  Request.get(url).set('Authorization', 'Bearer ' + token).set('Accept', 'application/json').query({ take: take }).query({ from: from }).query({ sort: 'date:1' }).query({ per_page: take }).end(function (err, res) {
	    if (err || !res.ok) {
	      console.log('Error getting logs', err);
	      cb(null, err);
	    } else {
	      console.log('x-ratelimit-limit: ', res.headers['x-ratelimit-limit']);
	      console.log('x-ratelimit-remaining: ', res.headers['x-ratelimit-remaining']);
	      console.log('x-ratelimit-reset: ', res.headers['x-ratelimit-reset']);
	      cb(res.body);
	    }
	  });
	}

	var getTokenCached = memoizer({
	  load: function load(apiUrl, audience, clientId, clientSecret, cb) {
	    Request.post(apiUrl).send({
	      audience: audience,
	      grant_type: 'client_credentials',
	      client_id: clientId,
	      client_secret: clientSecret
	    }).type('application/json').end(function (err, res) {
	      if (err || !res.ok) {
	        cb(null, err);
	      } else {
	        cb(res.body.access_token);
	      }
	    });
	  },
	  hash: function hash(apiUrl) {
	    return apiUrl;
	  },
	  max: 100,
	  maxAge: 1000 * 60 * 60
	});

	app.use(function (req, res, next) {
	  var apiUrl = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/oauth/token';
	  var audience = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/api/v2/';
	  var clientId = req.webtaskContext.data.AUTH0_CLIENT_ID;
	  var clientSecret = req.webtaskContext.data.AUTH0_CLIENT_SECRET;

	  getTokenCached(apiUrl, audience, clientId, clientSecret, function (access_token, err) {
	    if (err) {
	      console.log('Error getting access_token', err);
	      return next(err);
	    }

	    req.access_token = access_token;
	    next();
	  });
	});

	app.get('/', lastLogCheckpoint);
	app.post('/', lastLogCheckpoint);

	module.exports = Webtask.fromExpress(app);

/***/ },
/* 1 */
/***/ function(module, exports) {

	module.exports = require("winston");

/***/ },
/* 2 */
/***/ function(module, exports) {

	module.exports = require("async");

/***/ },
/* 3 */
/***/ function(module, exports) {

	module.exports = require("moment");

/***/ },
/* 4 */
/***/ function(module, exports) {

	module.exports = require("useragent");

/***/ },
/* 5 */
/***/ function(module, exports) {

	module.exports = require("express");

/***/ },
/* 6 */
/***/ function(module, exports, __webpack_require__) {

	exports.fromConnect = exports.fromExpress = fromConnect;
	exports.fromHapi = fromHapi;
	exports.fromServer = exports.fromRestify = fromServer;


	// API functions

	function fromConnect (connectFn) {
	    return function (context, req, res) {
	        var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);

	        req.originalUrl = req.url;
	        req.url = req.url.replace(normalizeRouteRx, '/');
	        req.webtaskContext = attachStorageHelpers(context);

	        return connectFn(req, res);
	    };
	}

	function fromHapi(server) {
	    var webtaskContext;

	    server.ext('onRequest', function (request, response) {
	        var normalizeRouteRx = createRouteNormalizationRx(request.x_wt.jtn);

	        request.setUrl(request.url.replace(normalizeRouteRx, '/'));
	        request.webtaskContext = webtaskContext;
	    });

	    return function (context, req, res) {
	        var dispatchFn = server._dispatch();

	        webtaskContext = attachStorageHelpers(context);

	        dispatchFn(req, res);
	    };
	}

	function fromServer(httpServer) {
	    return function (context, req, res) {
	        var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);

	        req.originalUrl = req.url;
	        req.url = req.url.replace(normalizeRouteRx, '/');
	        req.webtaskContext = attachStorageHelpers(context);

	        return httpServer.emit('request', req, res);
	    };
	}


	// Helper functions

	function createRouteNormalizationRx(jtn) {
	    var normalizeRouteBase = '^\/api\/run\/[^\/]+\/';
	    var normalizeNamedRoute = '(?:[^\/\?#]*\/?)?';

	    return new RegExp(
	        normalizeRouteBase + (
	        jtn
	            ?   normalizeNamedRoute
	            :   ''
	    ));
	}

	function attachStorageHelpers(context) {
	    context.read = context.secrets.EXT_STORAGE_URL
	        ?   readFromPath
	        :   readNotAvailable;
	    context.write = context.secrets.EXT_STORAGE_URL
	        ?   writeToPath
	        :   writeNotAvailable;

	    return context;


	    function readNotAvailable(path, options, cb) {
	        var Boom = __webpack_require__(7);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function readFromPath(path, options, cb) {
	        var Boom = __webpack_require__(7);
	        var Request = __webpack_require__(8);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        Request({
	            uri: context.secrets.EXT_STORAGE_URL,
	            method: 'GET',
	            headers: options.headers || {},
	            qs: { path: path },
	            json: true,
	        }, function (err, res, body) {
	            if (err) return cb(Boom.wrap(err, 502));
	            if (res.statusCode === 404 && Object.hasOwnProperty.call(options, 'defaultValue')) return cb(null, options.defaultValue);
	            if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));

	            cb(null, body);
	        });
	    }

	    function writeNotAvailable(path, data, options, cb) {
	        var Boom = __webpack_require__(7);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function writeToPath(path, data, options, cb) {
	        var Boom = __webpack_require__(7);
	        var Request = __webpack_require__(8);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        Request({
	            uri: context.secrets.EXT_STORAGE_URL,
	            method: 'PUT',
	            headers: options.headers || {},
	            qs: { path: path },
	            body: data,
	        }, function (err, res, body) {
	            if (err) return cb(Boom.wrap(err, 502));
	            if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));

	            cb(null);
	        });
	    }
	}


/***/ },
/* 7 */
/***/ function(module, exports) {

	module.exports = require("boom");

/***/ },
/* 8 */
/***/ function(module, exports) {

	module.exports = require("request");

/***/ },
/* 9 */
/***/ function(module, exports) {

	module.exports = require("superagent");

/***/ },
/* 10 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(setImmediate) {const LRU = __webpack_require__(13);
	const _ = __webpack_require__(14);
	const lru_params =  [ 'max', 'maxAge', 'length', 'dispose', 'stale' ];

	module.exports = function (options) {
	  var cache = new LRU(_.pick(options, lru_params));
	  var load = options.load;
	  var hash = options.hash;

	  var result = function () {
	    var args = _.toArray(arguments);
	    var parameters = args.slice(0, -1);
	    var callback = args.slice(-1).pop();

	    var key;

	    if (parameters.length === 0 && !hash) {
	      //the load function only receives callback.
	      key = '_';
	    } else {
	      key = hash.apply(options, parameters);
	    }

	    var fromCache = cache.get(key);

	    if (fromCache) {
	      return setImmediate.apply(null, [callback, null].concat(fromCache));
	    }

	    load.apply(null, parameters.concat(function (err) {
	      if (err) {
	        return callback(err);
	      }

	      cache.set(key, _.toArray(arguments).slice(1));

	      return callback.apply(null, arguments);

	    }));

	  };

	  result.keys = cache.keys.bind(cache);

	  return result;
	};


	module.exports.sync = function (options) {
	  var cache = new LRU(_.pick(options, lru_params));
	  var load = options.load;
	  var hash = options.hash;

	  var result = function () {
	    var args = _.toArray(arguments);

	    var key = hash.apply(options, args);

	    var fromCache = cache.get(key);

	    if (fromCache) {
	      return fromCache;
	    }

	    var result = load.apply(null, args);

	    cache.set(key, result);

	    return result;
	  };

	  result.keys = cache.keys.bind(cache);

	  return result;
	};
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(11).setImmediate))

/***/ },
/* 11 */
/***/ function(module, exports, __webpack_require__) {

	/* WEBPACK VAR INJECTION */(function(setImmediate, clearImmediate) {var nextTick = __webpack_require__(12).nextTick;
	var apply = Function.prototype.apply;
	var slice = Array.prototype.slice;
	var immediateIds = {};
	var nextImmediateId = 0;

	// DOM APIs, for completeness

	exports.setTimeout = function() {
	  return new Timeout(apply.call(setTimeout, window, arguments), clearTimeout);
	};
	exports.setInterval = function() {
	  return new Timeout(apply.call(setInterval, window, arguments), clearInterval);
	};
	exports.clearTimeout =
	exports.clearInterval = function(timeout) { timeout.close(); };

	function Timeout(id, clearFn) {
	  this._id = id;
	  this._clearFn = clearFn;
	}
	Timeout.prototype.unref = Timeout.prototype.ref = function() {};
	Timeout.prototype.close = function() {
	  this._clearFn.call(window, this._id);
	};

	// Does not start the time, just sets up the members needed.
	exports.enroll = function(item, msecs) {
	  clearTimeout(item._idleTimeoutId);
	  item._idleTimeout = msecs;
	};

	exports.unenroll = function(item) {
	  clearTimeout(item._idleTimeoutId);
	  item._idleTimeout = -1;
	};

	exports._unrefActive = exports.active = function(item) {
	  clearTimeout(item._idleTimeoutId);

	  var msecs = item._idleTimeout;
	  if (msecs >= 0) {
	    item._idleTimeoutId = setTimeout(function onTimeout() {
	      if (item._onTimeout)
	        item._onTimeout();
	    }, msecs);
	  }
	};

	// That's not how node.js implements it but the exposed api is the same.
	exports.setImmediate = typeof setImmediate === "function" ? setImmediate : function(fn) {
	  var id = nextImmediateId++;
	  var args = arguments.length < 2 ? false : slice.call(arguments, 1);

	  immediateIds[id] = true;

	  nextTick(function onNextTick() {
	    if (immediateIds[id]) {
	      // fn.call() is faster so we optimize for the common use-case
	      // @see http://jsperf.com/call-apply-segu
	      if (args) {
	        fn.apply(null, args);
	      } else {
	        fn.call(null);
	      }
	      // Prevent ids from leaking
	      exports.clearImmediate(id);
	    }
	  });

	  return id;
	};

	exports.clearImmediate = typeof clearImmediate === "function" ? clearImmediate : function(id) {
	  delete immediateIds[id];
	};
	/* WEBPACK VAR INJECTION */}.call(exports, __webpack_require__(11).setImmediate, __webpack_require__(11).clearImmediate))

/***/ },
/* 12 */
/***/ function(module, exports) {

	// shim for using process in browser

	var process = module.exports = {};
	var queue = [];
	var draining = false;
	var currentQueue;
	var queueIndex = -1;

	function cleanUpNextTick() {
	    draining = false;
	    if (currentQueue.length) {
	        queue = currentQueue.concat(queue);
	    } else {
	        queueIndex = -1;
	    }
	    if (queue.length) {
	        drainQueue();
	    }
	}

	function drainQueue() {
	    if (draining) {
	        return;
	    }
	    var timeout = setTimeout(cleanUpNextTick);
	    draining = true;

	    var len = queue.length;
	    while(len) {
	        currentQueue = queue;
	        queue = [];
	        while (++queueIndex < len) {
	            if (currentQueue) {
	                currentQueue[queueIndex].run();
	            }
	        }
	        queueIndex = -1;
	        len = queue.length;
	    }
	    currentQueue = null;
	    draining = false;
	    clearTimeout(timeout);
	}

	process.nextTick = function (fun) {
	    var args = new Array(arguments.length - 1);
	    if (arguments.length > 1) {
	        for (var i = 1; i < arguments.length; i++) {
	            args[i - 1] = arguments[i];
	        }
	    }
	    queue.push(new Item(fun, args));
	    if (queue.length === 1 && !draining) {
	        setTimeout(drainQueue, 0);
	    }
	};

	// v8 likes predictible objects
	function Item(fun, array) {
	    this.fun = fun;
	    this.array = array;
	}
	Item.prototype.run = function () {
	    this.fun.apply(null, this.array);
	};
	process.title = 'browser';
	process.browser = true;
	process.env = {};
	process.argv = [];
	process.version = ''; // empty string to avoid regexp issues
	process.versions = {};

	function noop() {}

	process.on = noop;
	process.addListener = noop;
	process.once = noop;
	process.off = noop;
	process.removeListener = noop;
	process.removeAllListeners = noop;
	process.emit = noop;

	process.binding = function (name) {
	    throw new Error('process.binding is not supported');
	};

	process.cwd = function () { return '/' };
	process.chdir = function (dir) {
	    throw new Error('process.chdir is not supported');
	};
	process.umask = function() { return 0; };


/***/ },
/* 13 */
/***/ function(module, exports) {

	module.exports = require("lru-cache");

/***/ },
/* 14 */
/***/ function(module, exports) {

	module.exports = require("lodash");

/***/ },
/* 15 */
/***/ function(module, exports, __webpack_require__) {

	/*
	 * winston-papertrail.js:
	 *
	 *          Transport for logging to Papertrail Service
	 *          www.papertrailapp.com
	 *
	 * (C) 2013 Ken Perkins
	 * MIT LICENCE
	 *
	 */

	var os = __webpack_require__(16),
	    net = __webpack_require__(17),
	    tls = __webpack_require__(18),
	    syslogProducer = __webpack_require__(19).Produce,
	    util = __webpack_require__(22),
	    winston = __webpack_require__(1);

	/**
	 * Papertrail class
	 *
	 * @description constructor for the Papertrail transport
	 *
	 * @param {object}      options                 options for your papertrail transport
	 *
	 * @param {string}      options.host            host for papertrail endpoint
	 *
	 * @param {Number}      options.port            port for papertrail endpoint
	 *
	 * @param {Boolean}     [options.disableTls]    disable TLS connections, enabled by default
	 *
	 * @param {string}      [options.hostname]      name for the logging hostname in Papertrail
	 *
	 * @param {string}      [options.program]       name for the logging program
	 *
	 * @param {string}      [options.facility]      syslog facility for log messages
	 *
	 * @param {string}      [options.level]         log level for your transport (info)
	 *
	 * @param {Function}    [options.logFormat]     function to format your log message before sending
	 *
	 * @param {Number}      [options.attemptsBeforeDecay]       how many reconnections should
	 *                                                          be attempted before backing of (5)
	 *
	 * @param {Number}      [options.maximumAttempts]           maximum attempts before
	 *                                                          disabling buffering (25)
	 *
	 * @param {Number}      [options.connectionDelay]           delay between
	 *                                                          reconnection attempts in ms (1000)
	 *
	 * @param {Boolean}     [options.handleExceptions]          passed to base Transport (false)
	 *
	 * @param {Boolean}     [options.colorize]                  enable colors in Papertrail (false)
	 *
	 * @param {Number}      [options.maxDelayBetweenReconnection]   when backing off,
	 *                                                              what's the max time between
	 *                                                              reconnections (ms)
	 *
	 * @param {Boolean}     [options.inlineMeta]        inline multi-line messages (false)
	 *
	 * @type {Function}
	 */
	var Papertrail = exports.Papertrail = function (options) {

	    var self = this;

	    self._KEEPALIVE_INTERVAL = 15 * 1000;

	    options = options || {};

	    self.name = 'Papertrail';
	    self.level = options.level || 'info';

	    // Papertrail Service Host
	    self.host = options.host;

	    // Papertrail Service Port
	    self.port = options.port;

	    // Disable TLS connections (enabled by default)
	    self.disableTls = typeof options.disableTls === 'boolean' ? options.disableTls : false;

	    // Hostname of the current app
	    self.hostname = options.hostname || os.hostname();

	    // Program is an affordance for Papertrail to name the source of log entries
	    self.program = options.program || 'default';

	    // Syslog facility to log messages as to Papertrail
	    self.facility = options.facility || 'daemon';

	    // Send ANSI color codes through to Papertrail
	    self.colorize = options.colorize || false;

	    // Format your log messages prior to delivery
	    self.logFormat = options.logFormat || function (level, message) {
	        return level + ' ' + message;
	    };

	    // Number of attempts before decaying reconnection
	    self.attemptsBeforeDecay = options.attemptsBeforeDecay || 5;

	    // Maximum number of reconnection attempts before disabling buffer
	    self.maximumAttempts = options.maximumAttempts || 25;

	    // Delay between normal attempts
	    self.connectionDelay = options.connectionDelay || 1000;

	    // Handle Exceptions
	    self.handleExceptions = options.handleExceptions || false;

	    // Maximum delay between attempts
	    self.maxDelayBetweenReconnection =
	        options.maxDelayBetweenReconnection || 60000;

	    // Maximum buffer size (default: 1MB)
	    self.maxBufferSize =
	        options.maxBufferSize || 1 * 1024 * 1024;

	    // Inline meta flag
	    self.inlineMeta = options.inlineMeta || false;

	    self.producer = new syslogProducer({ facility: self.facility });

	    self.currentRetries = 0;
	    self.totalRetries = 0;
	    self.buffer = '';
	    self.loggingEnabled = true;
	    self._shutdown = false;

	    // Error out if we don't have a host or port
	    if (!self.host || !self.port) {
	        throw new Error('Missing required parameters: host and port');
	    }

	    // Open the connection
	    connectStream();

	    // Opens a connection to Papertrail
	    function connectStream() {
	        // don't connect on either error or shutdown
	        if (self._shutdown || self._erroring) {
	            return;
	        }

	        try {

	            function wireStreams() {
	                self.stream.on('error', onErrored);

	                // If we have the stream end, simply reconnect
	                self.stream.on('end', connectStream);
	            }

	            if (self.disableTls) {
	                self.stream = net.createConnection(self.port, self.host, onConnected);
	                self.stream.setKeepAlive(true, self._KEEPALIVE_INTERVAL);

	                wireStreams();
	            }
	            else {
	                var socket = net.createConnection(self.port, self.host, function () {
	                    socket.setKeepAlive(true, self._KEEPALIVE_INTERVAL);

	                    self.stream = tls.connect({
	                        socket: socket,
	                        rejectUnauthorized: false
	                    }, onConnected);

	                    wireStreams();
	                });

	                socket.on('error', onErrored);
	            }
	        }
	        catch (e) {
	            onErrored(e);
	        }
	    }

	    function onErrored(err) {
	        // make sure we prevent simultaneous attempts to connect and handle errors
	        self._erroring = true;

	        self.emit('error', err);

	        // We may be disconnected from the papertrail endpoint for any number of reasons;
	        // i.e. inactivity, network problems, etc, and we need to be resilient against this
	        // that said, we back off reconnection attempts in case Papertrail is truly down
	        setTimeout(function () {
	            // Increment our retry counts
	            self.currentRetries++;
	            self.totalRetries++;

	            // Decay the retry rate exponentially up to max between attempts
	            if ((self.connectionDelay < self.maxDelayBetweenReconnection) &&
	            (self.currentRetries >= self.attemptsBeforeDecay)) {
	                self.connectionDelay = self.connectionDelay * 2;
	                self.currentRetries = 0;
	            }

	            // Stop buffering messages after a fixed number of retries.
	            // This is to keep the buffer from growing unbounded
	            if (self.loggingEnabled &&
	                (self.totalRetries >= (self.maximumAttempts))) {
	                    self.loggingEnabled = false;
	                    self.emit('error', new Error('Max entries eclipsed, disabling buffering'));
	            }

	            // continue
	            self._erroring = false;
	            connectStream();

	        }, self.connectionDelay);
	    }

	    function onConnected() {
	        // Reset our variables
	        self.loggingEnabled = true;
	        self.currentRetries = 0;
	        self.totalRetries = 0;
	        self.connectionDelay = options.connectionDelay || 1000;

	        self.emit('connect', 'Connected to Papertrail at ' + self.host + ':' + self.port);

	        // Did we get messages buffered
	        if (self.buffer.length > 0) {
	            self.stream.write(self.buffer);
	            self.buffer = '';
	        }
	    }
	};

	//
	//
	// Inherit from `winston.Transport` so you can take advantage
	// of the base functionality and `.handleExceptions()`.
	//
	util.inherits(Papertrail, winston.Transport);

	//
	// Define a getter so that `winston.transports.Papertrail`
	// is available and thus backwards compatible.
	//
	winston.transports.Papertrail = Papertrail;

	/**
	 * Papertrail.log
	 *
	 * @description Core logging method exposed to Winston. Metadata is optional.
	 *
	 * @param {String}        level    Level at which to log the message.
	 * @param {String}        msg        Message to log
	 * @param {String|object|Function}        [meta]    Optional metadata to attach
	 * @param {Function}    callback
	 * @returns {*}
	 */
	Papertrail.prototype.log = function (level, msg, meta, callback) {

	    var self = this;

	    // make sure we handle when meta isn't provided
	    if (typeof(meta) === 'function' && !callback) {
	        callback = meta;
	        meta = false;
	    }

	    if  (meta && typeof meta === 'object' && (Object.keys(meta).length === 0)
			&& (!util.isError(meta)))
		{
	        meta = false;
	    }

	    // If the logging buffer is disabled, drop the message on the floor
	    if (!this.loggingEnabled) {
	        return callback(null, true);
	    }

	    var output = msg;

	    // If we don't have a string for the message,
	    // lets transform it before moving on
	    if (typeof(output) !== 'string') {
	        output = util.inspect(output, false, null, self.colorize);
	    }

	    if (meta) {
	        if (typeof meta !== 'object') {
	            output += ' ' + meta;
	        }
	        else if (meta) {
	            if (this.inlineMeta) {
	                output += ' ' + util.inspect(meta, false, null, self.colorize).replace(/[\n\t]\s*/gm, " ");
	            }
	            else {
	                output += '\n' + util.inspect(meta, false, null, self.colorize);
	            }
	        }
	    }

	    this.sendMessage(this.hostname, this.program, level, output);

	    callback(null, true);
	};

	/**
	 * Papertrail.sendMessage
	 *
	 * @description sending the message to the stream, or buffering if not connected
	 *
	 * @param {String}    hostname    Hostname of the source application.
	 * @param {String}    program     Name of the source application
	 * @param {String}    level        Log level of the message
	 * @param {String}    message        The message to deliver
	 */
	Papertrail.prototype.sendMessage = function (hostname, program, level, message) {

	    var self = this,
	        lines = [],
	        msg = '',
	        gap = '';

	    // Only split if we actually have a message
	    if (message) {
	        lines = message.split('\n');
	    }
	    else {
	        lines = [''];
	    }

	    // If the incoming message has multiple lines, break them and format each
	    // line as it's own message
	    for (var i = 0; i < lines.length; i++) {

	        // don't send extra message if our message ends with a newline
	        if ((lines[i].length === 0) && (i == lines.length - 1)) {
	            break;
	        }

	        if (i == 1) {
	            gap = '    ';
	        }

	        msg += self.producer.produce({
	            severity: level,
	            host: hostname,
	            appName: program,
	            date: new Date(),
	            message: self.logFormat(self.colorize ? winston.config.colorize(level) : level, gap + lines[i])
	        }) + '\r\n';
	    }

	    if (this.stream && this.stream.writable) {
	        this.stream.write(msg);
	    }
	    else if (this.loggingEnabled && this.buffer.length < this.maxBufferSize) {
	        this.buffer += msg;
	    }
	};

	/**
	 * Papertrail.close
	 *
	 * @description closes the underlying TLS connection and disables automatic
	 * reconnection, allowing the process to exit
	 */
	Papertrail.prototype.close = function() {
	    var self = this;

	    self._shutdown = true;
	    
	    if (self.stream) {
	        self.stream.end();
	    }
	    // if there's no stream yet, that means we're still connecting
	    // lets wire a connect handler, and then invoke close again
	    else {
	        self.on('connect', function() {
	            self.close();
	        });
	    }
	};


/***/ },
/* 16 */
/***/ function(module, exports) {

	module.exports = require("os");

/***/ },
/* 17 */
/***/ function(module, exports) {

	module.exports = require("net");

/***/ },
/* 18 */
/***/ function(module, exports) {

	module.exports = require("tls");

/***/ },
/* 19 */
/***/ function(module, exports, __webpack_require__) {

	/*
	 *  Imports
	 */

	var producer = __webpack_require__(20);
	var parser   = __webpack_require__(21);

	/*
	 *  Exports
	 */
	exports.Produce = producer;
	exports.Parse   = parser;


/***/ },
/* 20 */
/***/ function(module, exports, __webpack_require__) {

	/*
	 *    Glossy Producer - Generate valid syslog messages
	 *
	 *    Copyright Squeeks <privacymyass@gmail.com>.
	 *    This is free software licensed under the MIT License - 
	 *    see the LICENSE file that should be included with this package.
	 */

	/*
	 *    These values replace the integers in message that define the facility.
	 */
	var FacilityIndex = {
	    'kern':   0,  // kernel messages
	    'user':   1,  // user-level messages
	    'mail':   2,  // mail system
	    'daemon': 3,  // system daemons
	    'auth':   4,  // security/authorization messages
	    'syslog': 5,  // messages generated internally by syslogd
	    'lpr':    6,  // line printer subsystem
	    'news':   7,  // network news subsystem
	    'uucp':   8,  // UUCP subsystem
	    'clock':  9,  // clock daemon
	    'sec':    10, // security/authorization messages
	    'ftp':    11, // FTP daemon
	    'ntp':    12, // NTP subsystem
	    'audit':  13, // log audit
	    'alert':  14, // log alert
	//  'clock':  15, // clock daemon (note 2)
	    'local0': 16, // local use 0  (local0)
	    'local1': 17, // local use 1  (local1)
	    'local2': 18, // local use 2  (local2)
	    'local3': 19, // local use 3  (local3)
	    'local4': 20, // local use 4  (local4)
	    'local5': 21, // local use 5  (local5)
	    'local6': 22, // local use 6  (local6)
	    'local7': 23  // local use 7  (local7)
	};

	// Note 1 - Various operating systems have been found to utilize
	//           Facilities 4, 10, 13 and 14 for security/authorization,
	//           audit, and alert messages which seem to be similar. 

	// Note 2 - Various operating systems have been found to utilize
	//           both Facilities 9 and 15 for clock (cron/at) messages.

	/*
	 *    These values replace the integers in message that define the severity.
	 */
	var SeverityIndex = {
	    'emerg': 0,                 // Emergency: system is unusable
	    'emergency': 0,

	    'alert': 1,                 // Alert: action must be taken immediately

	    'crit': 2,                  // Critical: critical conditions
	    'critical': 2,

	    'err': 3,                   // Error: error conditions
	    'error': 3,

	    'warn': 4,                  // Warning: warning conditions
	    'warning': 4,

	    'notice': 5,                // Notice: normal but significant condition

	    'info': 6  ,                // Informational: informational messages
	    'information': 6,
	    'informational': 6,

	    'debug':  7                 // Debug: debug-level messages
	};


	/*
	 *    Defines the range matching BSD style months to integers.
	 */
	var BSDDateIndex = [
	    'Jan',
	    'Feb',
	    'Mar',
	    'Apr',
	    'May',
	    'Jun',
	    'Jul',
	    'Aug',
	    'Sep',
	    'Oct',
	    'Nov',
	    'Dec'
	];


	/*
	 *  GlossyProducer class
	 *  @param {Object} provides persistent details of all messages:
	 *      facility: The facility index
	 *      severity: Severity index
	 *      host: Host address, either name or IP
	 *      appName: Application/Process name
	 *      pid: Process ID
	 *      msgID: Message ID (RFC5424 only)
	 *      type: RFC3164/RFC5424 message type
	 *  @return {Object} GlossyProducer object
	 */
	var GlossyProducer = function(options) {
	    if(options && typeof options =='object' && options.type) {
	        this.type = options.type.match(/bsd|3164/i) ? "RFC3164" : "RFC5424";
	    } else if(options && typeof options == 'string') {
	        this.type = options.match(/bsd|3164/i) ? "RFC3164" : "RFC5424";
	    } else {
	        this.type = "RFC5424";
	    }

	    if(options && options.facility && FacilityIndex[options.facility]) {
	        this.facility = options.facility;
	    }
	    if(options && options.pid && parseInt(options.pid, 10)) {
	        this.pid = options.pid;
	    }
	    if(options && options.host)    this.host    = options.host.replace(/\s+/g, '');
	    if(options && options.appName) this.appName = options.appName.replace(/\s+/g, '');
	    if(options && options.msgID)   this.msgID   = options.msgID.replace(/\s+/g, '');

	};


	/*
	 *  @param {Object} options object containing details of the message:
	 *      facility: The facility index
	 *      severity: Severity index
	 *      prival: RFC5424 PRIVAL field - will override facility/severity if in valid [0-191] range and both provided
	 *         see ABNF at: (http://tools.ietf.org/html/rfc5424#section-6) 
	 *      host: Host address, either name or IP
	 *      appName: Application ID
	 *      pid: Process ID
	 *      date: Timestamp to be applied, uses current GMT by default
	 *      time: Optional Date() argument may be used in lieu of 'date' - allows parse() output to be used for produce args
	 *      msgID: Message ID (RFC5424 only)
	 *      structuredData: Object of structured data (RFC5424 only)
	 *      message: The message to be sent
	 *
	 *  @param {Function} callback a callback run once the message is built
	 *  @return {String} compiledMessage on completion, false on failure
	 */
	GlossyProducer.prototype.produce = function(options, callback) {
	    // TODO: next breaking api change make key output from parse() consistent with produce input options
	    if(options.time instanceof Date && !options.date) options.date = options.time;

	    var msgData = [];
	    if(!options.date instanceof Date) {
	        options.date = new Date(Date());
	    }
	    
	    if(!options.facility) options.facility = this.facility;

	    if(this.type == 'RFC5424') {
	        if(options.hasOwnProperty('prival') && options.prival >= 0 && options.prival <= 191) {
	          var prival = '<' + options.prival + '>1';
	        }
	        else {
	          var prival = calculatePrival({ 
	            facility: options.facility,
	            severity: options.severity,
	            version:  1
	          });
	        }

	        if(prival === false) return false;

	        msgData.push(prival);
	        msgData.push(generateDate(options.date));

	        msgData.push(options.host    || this.host    || '-');
	        msgData.push(options.appName || this.appName || '-');
	        msgData.push(options.pid     || this.pid     || '-');
	        msgData.push(options.msgID   || this.msgID   || '-');
	        if(options.structuredData) {
	            msgData.push(generateStructuredData(options.structuredData) || '-');
	        } else {
	            msgData.push('-');
	        }

	        if(!options.message) options.message = '-';

	    } else {
	        options.timestamp = generateBSDDate(options.date);    
	        msgData.push(
	            calculatePrival({ 
	                facility: options.facility,
	                severity: options.severity
	            }) + options.timestamp
	        );

	        msgData.push(options.host || this.host);
	        msgData.push();
	        if(options.appName || this.appName) {
	            var app = options.appName || this.appName;
	            var pid = options.pid     || this.pid;

	            if(parseInt(pid, 10)) {
	                msgData.push(app + '[' + pid + ']:');
	            } else {
	                msgData.push(app + ':');
	            }
	        }
	    }

	    var compiledMessage = msgData.filter(function (messageElement) {
	        // Filter null/ undefined values
	        return messageElement;
	    }).map(function (messageElement) {
	        // Trim messages to remove successive whitespace
	        return String(messageElement).trim();
	    }).join(' ');
	    compiledMessage += ' ' + options.message || '';
	    msgData.push(compiledMessage);

	    if(callback) {
	        return callback(compiledMessage);
	    } else {
	        return compiledMessage;
	    }

	};


	/*
	 *  @param {Object} options object containing details of the message with
	 *      the severity as 'debug'
	 *  @param {Function} callback a callback run once the message is built
	 *  @return {String} compiledMessage on completion, false on failure
	 */
	GlossyProducer.prototype.debug = function(options, callback) {
	    options.severity = 'debug';
	    return this.produce(options, callback);
	};


	/*
	 *  @param {Object} options object containing details of the message with
	 *      the severity as 'info'
	 *  @param {Function} callback a callback run once the message is built
	 *  @return {String} compiledMessage on completion, false on failure
	 */
	GlossyProducer.prototype.info = function(options, callback) {
	    options.severity = 'info';
	    return this.produce(options, callback);
	};


	/*
	 *  @param {Object} options object containing details of the message with
	 *      the severity as 'notice'
	 *  @param {Function} callback a callback run once the message is built
	 *  @return {String} compiledMessage on completion, false on failure
	 */
	GlossyProducer.prototype.notice = function(options, callback) {
	    options.severity = 'notice';
	    return this.produce(options, callback);
	};


	/*
	 *  @param {Object} options object containing details of the message with
	 *      the severity as 'warn'
	 *  @param {Function} callback a callback run once the message is built
	 *  @return {String} compiledMessage on completion, false on failure
	 */
	GlossyProducer.prototype.warn = function(options, callback) {
	    options.severity = 'warn';
	    return this.produce(options, callback);
	};


	/*
	 *  @param {Object} options object containing details of the message with
	 *      the severity as 'crit'
	 *  @param {Function} callback a callback run once the message is built
	 *  @return {String} compiledMessage on completion, false on failure
	 */
	GlossyProducer.prototype.crit = function(options, callback) {
	    options.severity = 'crit';
	    return this.produce(options, callback);
	};


	/*
	 *  @param {Object} options object containing details of the message with
	 *      the severity as 'alert'
	 *  @param {Function} callback a callback run once the message is built
	 *  @return {String} compiledMessage on completion, false on failure
	 */
	GlossyProducer.prototype.alert = function(options, callback) {
	    options.severity = 'alert';
	    return this.produce(options, callback);
	};


	/*
	 *  @param {Object} options object containing details of the message with
	 *      the severity as 'emergency'
	 *  @param {Function} callback a callback run once the message is built
	 *  @return {String} compiledMessage on completion, false on failure
	 */
	GlossyProducer.prototype.emergency = function(options, callback) {
	    options.severity = 'emergency';
	    return this.produce(options, callback);
	};


	/*
	 *  Prepend a zero to a number less than 10
	 *  @param {Number} n
	 *  @return {String}
	 *
	 *  Where's sprintf when you need it?
	 */
	function leadZero(n) {
	    if(typeof n != 'number') return n;
	    n = n < 10 ? '0' + n : n ;
	    return n;
	}


	/*
	 *  Get current date in RFC 3164 format. If no date is supplied, the default
	 *  is the current time in GMT + 0.
	 *  @param {Date} dateObject optional Date object
	 *  @returns {String}
	 *
	 *  Features code taken from https://github.com/akaspin/ain
	 */
	function generateBSDDate(dateObject) {
	    if(!(dateObject instanceof Date)) dateObject = new Date(Date());
	    var hours   = leadZero(dateObject.getHours());
	    var minutes = leadZero(dateObject.getMinutes());
	    var seconds = leadZero(dateObject.getSeconds());
	    var month   = dateObject.getMonth();
	    var day     = dateObject.getDate();
	    if(day < 10) (day = ' ' + day);
	    return BSDDateIndex[month] + " " + day + " " + hours + ":" + minutes + ":" + seconds;
	}


	/*
	 *  Generate date in RFC 3339 format. If no date is supplied, the default is
	 *  the current time in GMT + 0.
	 *  @param {Date} dateObject optional Date object
	 *  @returns {String} formatted date
	 */
	function generateDate(dateObject) {
	    if(!(dateObject instanceof Date)) dateObject = new Date(Date());
	    
	    // Calcutate the offset
	    var timeOffset;
	    var minutes = Math.abs(dateObject.getTimezoneOffset());
	    var hours = 0;
	    while(minutes >= 60) {
	        hours++;
	        minutes -= 60;
	    }

	    if(dateObject.getTimezoneOffset() < 0) {
	        // Ahead of UTC
	        timeOffset = '+' + leadZero(hours) + '' + ':' + leadZero(minutes);
	    } else if(dateObject.getTimezoneOffset() > 0) {
	        // Behind UTC
	        timeOffset = '-' + leadZero(hours) + '' + ':' + leadZero(minutes);
	    } else {
	        // UTC
	        timeOffset = 'Z';
	    }


	    // Date
	    formattedDate = dateObject.getUTCFullYear()         + '-' +
	    // N.B. Javascript Date objects return months of the year indexed from
	    // zero, while the RFC 5424 syslog standard expects months indexed from
	    // one.
	    leadZero(dateObject.getUTCMonth() + 1)  + '-' +
	    // N.B. Javascript Date objects return days of the month indexed from one
	    // (unlike months of year), so this does not need any correction.
	    leadZero(dateObject.getUTCDate())   + 'T' +
	    // Time
	    leadZero(dateObject.getUTCHours())         + ':' +
	    leadZero(dateObject.getUTCMinutes())       + ':' +
	    leadZero(dateObject.getUTCSeconds())       + '.' +
	    leadZero(dateObject.getUTCMilliseconds())  +
	    timeOffset;
	    
	    return formattedDate;
	    
	}


	/*
	 *  Calculate the PRIVAL for a given facility
	 *  @param {Object} values Contains the three key arguments
	 *      facility {Number}/{String} the Facility Index
	 *      severity {Number}
	 *      version  {Number} For RFC 5424 messages, this should be 1
	 *
	 *  @return {String}
	 */
	function calculatePrival(values) {

	    var pri = {};
	    // Facility
	    if(typeof values.facility == 'string' && !values.facility.match(/^\d+$/)) {
	        pri.facility = FacilityIndex[values.facility.toLowerCase()];
	    } else if( parseInt(values.facility, 10) && parseInt(values.facility, 10) < 24) {
	        pri.facility = parseInt(values.facility, 10);
	    }

	    //Severity
	    if(typeof values.severity == 'string' && !values.severity.match(/^\d+$/)) {
	        pri.severity = SeverityIndex[values.severity.toLowerCase()];
	    } else if( parseInt(values.severity, 10) && parseInt(values.severity, 10) < 8) {
	        pri.severity = parseInt(values.severity, 10);
	    }

	    if(!isNaN(pri.severity) && !isNaN(pri.facility)) {
	        pri.prival = (pri.facility * 8) + pri.severity;
	        pri.str = values.version ? '<' + pri.prival + '>' + values.version : '<' + pri.prival + '>';
	        return pri.str;
	    } else {
	        return false;
	    }

	}


	/*
	 *  Serialise objects into the structured data segment
	 *  @param {Object} struct The object to serialise
	 *  @return {String} structuredData the serialised data
	 */
	function generateStructuredData(struct) {
	    if(typeof struct != 'object') return false;

	    var structuredData = '';
	    
	    for(var sdID in struct) {
	        sdElement = struct[sdID];
	        structuredData += '[' + sdID;
	        for(var key in sdElement) {
	            sdElement[key] = sdElement[key].toString().replace(/(\]|\\|")/g, '\\$1');
	            structuredData += ' ' + key + '="' + sdElement[key] + '"';
	        }
	        structuredData += ']';

	    }

	    return structuredData;
	}

	if(true) {
	    module.exports = GlossyProducer;
	}


/***/ },
/* 21 */
/***/ function(module, exports, __webpack_require__) {

	/*
	 *    Glossy Parser - Parse incoming syslog messages
	 *
	 *    Copyright Squeeks <privacymyass@gmail.com>.
	 *    This is free software licensed under the MIT License - 
	 *    see the LICENSE file that should be included with this package.
	 */

	/*
	 *    These values replace the integers in message that define the facility.
	 */
	var FacilityIndex = [
	    'kern',     // kernel messages
	    'user',     // user-level messages
	    'mail',     // mail system
	    'daemon',   // system daemons
	    'auth',     // security/authorization messages
	    'syslog',   // messages generated internally by syslogd
	    'lpr',      // line printer subsystem
	    'news',     // network news subsystem
	    'uucp',     // UUCP subsystem
	    'clock',    // clock daemon
	    'sec',      // security/authorization messages
	    'ftp',      // FTP daemon
	    'ntp',      // NTP subsystem
	    'audit',    // log audit
	    'alert',    // log alert
	    'clock',    // clock daemon (note 2)
	    'local0',   // local use 0  (local0)
	    'local1',   // local use 1  (local1)
	    'local2',   // local use 2  (local2)
	    'local3',   // local use 3  (local3)
	    'local4',   // local use 4  (local4)
	    'local5',   // local use 5  (local5)
	    'local6',   // local use 6  (local6)
	    'local7'    // local use 7  (local7)
	];

	// Note 1 - Various operating systems have been found to utilize
	//           Facilities 4, 10, 13 and 14 for security/authorization,
	//           audit, and alert messages which seem to be similar. 

	// Note 2 - Various operating systems have been found to utilize
	//           both Facilities 9 and 15 for clock (cron/at) messages.

	/*
	 *    These values replace the integers in message that define the severity.
	 */
	var SeverityIndex = [
	    'emerg',    // Emergency: system is unusable
	    'alert',    // Alert: action must be taken immediately
	    'crit',     // Critical: critical conditions
	    'err',      // Error: error conditions
	    'warn',     // Warning: warning conditions
	    'notice',   // Notice: normal but significant condition
	    'info',     // Informational: informational messages
	    'debug'     // Debug: debug-level messages
	];

	/*
	 *    Defines the range matching BSD style months to integers.
	 */
	var BSDDateIndex = {
	    'Jan': 0,
	    'Feb': 1,
	    'Mar': 2,
	    'Apr': 3,
	    'May': 4,
	    'Jun': 5,
	    'Jul': 6,
	    'Aug': 7,
	    'Sep': 8,
	    'Oct': 9,
	    'Nov': 10,
	    'Dec': 11
	};

	// These values match the hasing algorithm values as defined in RFC 5848
	var signedBlockValues = {

	    // Section 4.2.1
	    hashAlgorithm: [
	        null,
	        'SHA1',
	        'SHA256'
	    ],

	    // Section 5.2.1
	    keyBlobType: {
	        'C': 'PKIX Certificate',
	        'P': 'OpenPGP KeyID',
	        'K': 'Public Key',
	        'N': 'No key information',
	        'U': 'Unknown'
	    }

	};

	var GlossyParser = function() {};

	/*  
	 *  Parse the raw message received.
	 *
	 *  @param {String/Buffer} rawMessage Raw message received from socket
	 *  @param {Function} callback Callback to run after parse is complete
	 *  @return {Object} map containing all successfully parsed data.
	 */
	GlossyParser.prototype.parse = function(rawMessage, callback) {

	    // Are you node.js? Is this a Buffer?
	    if(typeof Buffer == 'function' && Buffer.isBuffer(rawMessage)) {
	        rawMessage = rawMessage.toString('utf8', 0);
	    } else if(typeof rawMessage != 'string') {
	        return rawMessage;
	    }

	    // Always return the original message
	    var parsedMessage = {
	        originalMessage: rawMessage
	    };
	    
	    var segments = rawMessage.split(' ');
	    if(segments.length < 2) return parsedMessage;
	    var priKeys = this.decodePri(segments[0]);
	    if(priKeys) {
	        for (var key in priKeys) parsedMessage[key] = priKeys[key];
	    }

	    var timeStamp;
	    //TODO Could our detection between 3164/5424 be improved?
	    if(segments[0].match(/^(<\d+>\d)$/))  {
	        segments.shift(); // Shift the prival off
	        timeStamp             = segments.shift();
	        parsedMessage.type    = 'RFC5424';
	        parsedMessage.time    = this.parseTimeStamp(timeStamp);
	        parsedMessage.host    = this.decideValue(segments.shift());
	        parsedMessage.appName = this.decideValue(segments.shift());
	        parsedMessage.pid     = this.decideValue(segments.shift());
	        parsedMessage.msgID   = this.decideValue(segments.shift());

	        if(segments[0] !== '-') {
	            var spliceMarker = 0;
	            for (i = segments.length -1; i > -1; i--) {
	                if(segments[i].substr(-1) === ']'){
	                    spliceMarker = i;
	                    spliceMarker++;
	                    break;
	                }
	            }
	            if(spliceMarker !== 0) {
	                var sd = segments.splice(0, spliceMarker).join(' ');
	                parsedMessage.structuredData = this.parseStructure(sd);

	                if(parsedMessage.structuredData.ssign) {
	                    parsedMessage.structuredData.signedBlock = 
	                        this.parseSignedBlock(parsedMessage.structuredData);
	                } else if(parsedMessage.structuredData['ssign-cert']) {
	                    parsedMessage.structuredData.signedBlock = 
	                        this.parseSignedCertificate(parsedMessage.structuredData);
	                }

	            }
	        } else {
	            segments.shift(); // Shift the SD marker off
	        }
	        parsedMessage.message = segments.join(' ');

	    } else if (segments[0].match(/^(<\d+>\d+:)$/)) {
	        parsedMessage.type    = 'RFC3164';
	        timeStamp             = segments.splice(0,1).join(' ').replace(/^(<\d+>)/,'');
	        parsedMessage.time    = this.parseBsdTime(timeStamp);
	        parsedMessage.message = segments.join(' ');

	    } else if(segments[0].match(/^(<\d+>\w+)/)) {
	        parsedMessage.type    = 'RFC3164';
	        if (segments[1] === '') segments.splice(1,1);
	        timeStamp             = segments.splice(0,3).join(' ').replace(/^(<\d+>)/,'');
	        parsedMessage.time    = this.parseBsdTime(timeStamp);
	        parsedMessage.host    = segments.shift();
	        parsedMessage.message = segments.join(' ');
	    }

	    if(callback) {
	        callback(parsedMessage);
	    } else {
	        return parsedMessage;
	    }

	};

	/*
	 *  RFC5424 messages are supposed to specify '-' as the null value
	 *  @param {String} a section from an RFC5424 message
	 *  @return {Boolean/String} null if string is entirely '-', or the original value
	 */
	GlossyParser.prototype.decideValue = function(value) {
	    return value === '-' ? null : value;
	};

	/*
	 *  Parses the PRI value from the start of message
	 *
	 *  @param {String} message Supplied raw primary value and version
	 *  @return {Object} Returns object containing Facility, Severity and Version
	 *      if correctly parsed, empty values on failure.
	 */
	GlossyParser.prototype.decodePri = function(message) {
	    if(typeof message != 'string') return;

	    var privalMatch = message.match(/^<(\d+)>/);
	    if(!privalMatch) return false;

	    var returnVal = {
	        prival: parseInt(privalMatch[1], 10)
	    };

	    if(privalMatch[2]) returnVal.versio = parseInt(privalMatch[2], 10);

	    if(returnVal.prival && returnVal.prival >= 0 && returnVal.prival <= 191) {
	    
	        returnVal.facilityID = parseInt(returnVal.prival / 8, 10);
	        returnVal.severityID = returnVal.prival - (returnVal.facilityID * 8);

	        if(returnVal.facilityID < 24 && returnVal.severityID < 8) {
	            returnVal.facility = FacilityIndex[returnVal.facilityID];
	            returnVal.severity = SeverityIndex[returnVal.severityID];
	        }
	    } else if(returnVal.prival >= 191) {
	        return false;
	    }

	    return returnVal;
	};


	/*
	 *  Attempts to parse a given timestamp
	 *  @param {String} timeStamp Supplied timestamp, should only be the timestamp, 
	 *      not the entire message
	 *  @return {Object} Date object on success
	 */
	GlossyParser.prototype.parseTimeStamp = function(timeStamp) {
	    
	    if(typeof timeStamp != 'string') return;
	    var parsedTime;

	    parsedTime = this.parse8601(timeStamp);
	    if(parsedTime) return parsedTime;

	    parsedTime = this.parseRfc3339(timeStamp);
	    if(parsedTime) return parsedTime;

	    parsedTime = this.parseBsdTime(timeStamp);
	    if(parsedTime) return parsedTime;

	    return parsedTime;

	};

	/*
	 *  Parse RFC3339 style timestamps
	 *  @param {String} timeStamp
	 *  @return {Date/false} Timestamp, if parsed correctly
	 *  @see http://blog.toppingdesign.com/2009/08/13/fast-rfc-3339-date-processing-in-javascript/
	 */
	GlossyParser.prototype.parseRfc3339 = function(timeStamp){
	    var utcOffset, offsetSplitChar, offsetString,
	        offsetMultiplier = 1,
	        dateTime = timeStamp.split("T");
	        if(dateTime.length < 2) return false;

	        var date    = dateTime[0].split("-"),
	        time        = dateTime[1].split(":"),
	        offsetField = time[time.length - 1];

	    offsetFieldIdentifier = offsetField.charAt(offsetField.length - 1);
	    if (offsetFieldIdentifier === "Z") {
	        utcOffset = 0;
	        time[time.length - 1] = offsetField.substr(0, offsetField.length - 2);
	    } else {
	        if (offsetField[offsetField.length - 1].indexOf("+") != -1) {
	            offsetSplitChar = "+";
	            offsetMultiplier = 1;
	        } else {
	            offsetSplitChar = "-";
	            offsetMultiplier = -1;
	        }

	        offsetString = offsetField.split(offsetSplitChar);
	        if(offsetString.length < 2) return false;
	        time[(time.length - 1)] = offsetString[0];
	        offsetString = offsetString[1].split(":");
	        utcOffset    = (offsetString[0] * 60) + offsetString[1];
	        utcOffset    = utcOffset * 60 * 1000;
	    }
	               
	    var parsedTime = new Date(Date.UTC(date[0], date[1] - 1, date[2], time[0], time[1], time[2]) + (utcOffset * offsetMultiplier ));
	    return parsedTime;
	};

	/*
	 *  Parse "BSD style" timestamps, as defined in RFC3164
	 *  @param {String} timeStamp
	 *  @return {Date/false} Timestamp, if parsed correctly
	 */
	GlossyParser.prototype.parseBsdTime = function(timeStamp) {
	    var parsedTime;
	    var d = timeStamp.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
	    if(d) {
	        // Years are absent from the specification, use this year
	        currDate   = new Date();
	        parsedTime = new Date(
	            currDate.getUTCFullYear(), 
	            BSDDateIndex[ d[1] ], 
	            d[2], 
	            d[3], 
	            d[4], 
	            d[5]);
	    }

	    return parsedTime;
	};

	/*
	 *  Parse ISO 8601 timestamps
	 *  @param {String} timeStamp
	 *  @return {Object/false} Timestamp, if successfully parsed
	 */
	GlossyParser.prototype.parse8601 = function(timeStamp) {
	    var parsedTime = new Date(Date.parse(timeStamp));
	    if(parsedTime.toString() === 'Invalid Date') return; //FIXME not the best
	    return parsedTime;
	};


	/*
	 *  Parse the structured data out of RFC5424 messages
	 *  @param {String} msg The STRUCTURED-DATA section
	 *  @return {Object} sdStructure parsed structure
	 */
	GlossyParser.prototype.parseStructure = function(msg) {
	    var sdStructure = { };

	    var state   = 0,
	        ignore  = false,
	        sdId    = '',
	        sdParam = '',
	        sdValue = '';

	    /*
	     * Build the structure using a horrible FSM.
	     * The states we cycle are as following:
	     *   0 1    2       34       20
	     *     [sdID sdParam="sdValue"]
	     */
	    for(var i = 0; i < msg.length; i++) {
	        var c = msg[i];
	        switch(state) {
	            case 0:  // SD-ELEMENT
	                state = (c === '[') ? 1 : 0;
	                break;
	            case 1: // SD-ID
	                if(c != ' ') {
	                    sdId += c;
	                } else {
	                    sdStructure[sdId] = {};
	                    state = 2;
	                }
	                break;
	            case 2: // SD-PARAM
	                if(c === '=') {
	                    sdStructure[sdId][sdParam] = '';
	                    state = 3;
	                } else if(c === ']') {
	                    sdId  = '';
	                    state = 0;
	                } else if(c != ' '){
	                    sdParam += c;
	                }
	                break;
	            case 3: // SD-PARAM/SD-VALUE
	                state = c === '"' ? 4 : null; // FIXME Handle rubbish better
	                break;
	            case 4: // SD-VALUE
	                if(c === '\\' && !ignore) {
	                    ignore = true;
	                } else if(c === '"' && !ignore) {
	                    sdStructure[sdId][sdParam] = sdValue;
	                    sdParam = '', sdValue = '';
	                    state = 2;
	                } else {
	                    sdValue += c;
	                    ignore = false;
	                }
	                break;
	            default:
	                break;
	        }
	    }
	    return sdStructure;
	};


	/*
	 *  Make sense of signed block messages
	 *  @param {Object} block the parsed structured data containing signed data
	 *  @return {Object} validatedBlock translated and named values, binary
	 *      elements will be Buffer objects, if available
	 */
	GlossyParser.prototype.parseSignedBlock = function(block) {

	    if(typeof block != 'object') return false;

	    var signedBlock    = { };
	    var validatedBlock = { };
	    // Figure out where in the object the keys live...
	    if(block.structuredData && block.structuredData.ssign) {
	        signedBlock = block.structuredData.ssign;
	    } else if(block.ssign) {
	        signedBlock = block.ssign;
	    } else if(block.VER) {
	        signedBlock = block;
	    } else {
	        return false;
	    }

	    var versionMatch = signedBlock.VER.match(/^(\d{2})(\d|\w)(\d)$/);
	    if(versionMatch !== null) {
	        validatedBlock.version        = versionMatch[1];
	        validatedBlock.hashAlgorithm  = parseInt(versionMatch[2], 10);
	        validatedBlock.hashAlgoString = signedBlockValues.hashAlgorithm[validatedBlock.hashAlgorithm];
	        validatedBlock.sigScheme      = parseInt(versionMatch[3], 10);
	    }

	    validatedBlock.rebootSessionID   = parseInt(signedBlock.RSID, 10);
	    validatedBlock.signatureGroup    = parseInt(signedBlock.SG, 10);
	    validatedBlock.signaturePriority = parseInt(signedBlock.SPRI, 10);
	    validatedBlock.globalBlockCount  = parseInt(signedBlock.GBC, 10);
	    validatedBlock.firstMsgNumber    = parseInt(signedBlock.FMN, 10);
	    validatedBlock.msgCount          = parseInt(signedBlock.CNT, 10);
	    validatedBlock.hashBlock         = signedBlock.HB.split(/\s/);

	    // Check to see if we're in node or have a Buffer type
	    if(typeof Buffer == 'function') {
	        for(var hash in validatedBlock.hashBlock) {
	            validatedBlock.hashBlock[hash] = new Buffer(
	                validatedBlock.hashBlock[hash], encoding='base64'); 
	        }
	        validatedBlock.thisSignature = new Buffer(
	            signedBlock.SIGN, encoding='base64');
	    } else {
	        validatedBlock.thisSignature = signedBlock.SIGN;
	    }

	    return validatedBlock;
	    
	};


	/*
	 *  Make sense of signed certificate messages
	 *  @param {Object} block the parsed structured data containing signed data
	 *  @return {Object} validatedBlock translated and named values, binary
	 *      elements will be Buffer objects, if available
	 */
	GlossyParser.prototype.parseSignedCertificate = function(block) {

	    if(typeof block != 'object') return false;

	    var signedBlock    = { };
	    var validatedBlock = { };
	    // Figure out where in the object the keys live...
	    if(block.structuredData && block.structuredData['ssign-cert']) {
	        signedBlock = block.structuredData['ssign-cert'];
	    } else if(block['ssign-cert']) {
	        signedBlock = block['ssign-cert'];
	    } else if(block.VER) {
	        signedBlock = block;
	    } else {
	        return false;
	    }

	    var versionMatch = signedBlock.VER.match(/^(\d{2})(\d|\w)(\d)$/);
	    if(versionMatch !== null) {
	        validatedBlock.version        = versionMatch[1];
	        validatedBlock.hashAlgorithm  = parseInt(versionMatch[2], 10);
	        validatedBlock.hashAlgoString = signedBlockValues.hashAlgorithm[validatedBlock.hashAlgorithm];
	        validatedBlock.sigScheme      = parseInt(versionMatch[3], 10);
	    }

	    validatedBlock.rebootSessionID     = parseInt(signedBlock.RSID, 10);
	    validatedBlock.signatureGroup      = parseInt(signedBlock.SG, 10);
	    validatedBlock.signaturePriority   = parseInt(signedBlock.SPRI, 10);
	    validatedBlock.totalPayloadLength  = parseInt(signedBlock.TPBL, 10);
	    validatedBlock.payloadIndex        = parseInt(signedBlock.INDEX, 10);
	    validatedBlock.fragmentLength      = parseInt(signedBlock.FLEN, 10);

	    var payloadFragment             = signedBlock.FRAG.split(/\s/);
	    validatedBlock.payloadTimestamp = this.parseTimeStamp(payloadFragment[0]);
	    validatedBlock.payloadType      = payloadFragment[1];
	    validatedBlock.payloadName      = signedBlockValues.keyBlobType[payloadFragment[1]];

	    if(typeof Buffer == 'function') {
	        validatedBlock.keyBlob = new Buffer(
	            payloadFragment[2], encoding='base64');
	        validatedBlock.thisSignature = new Buffer(
	            signedBlock.SIGN, encoding='base64');
	    } else {
	        validatedBlock.keyBlob       = payloadFragment[2];
	        validatedBlock.thisSignature = signedBlock.SIGN;
	    }

	    return validatedBlock;

	};


	if(true) {
	    module.exports = new GlossyParser();
	}


/***/ },
/* 22 */
/***/ function(module, exports) {

	module.exports = require("util");

/***/ }
/******/ ]);