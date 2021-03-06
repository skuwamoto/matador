var fs = require('fs')
  , express = module.exports = require('express')
  , path = require('path')
  , hogan = require('hogan.js')
  , klass = global.klass = require('klass')
  , v = global.v = require('valentine')
  , router = require('./router')
  , argv = module.exports.argv = require('optimist').argv
  , minifyViews = process.env.minify || false
  , paths = {
      SERVICES: 'services'
    , HELPERS: 'helpers'
    , MODELS: 'models'
    , CONTROLLERS: 'controllers'
  }
  , filenameSuffixes = {
      SERVICES: 'Service'
    , HELPERS: 'Helper'
    , MODELS: 'Model'
    , CONTROLLERS: 'Controller'
  }

var minify = function () {
  var r = /(<script[^>]*>[\s\S]+?<\/script>)/
    , scr = /^<script([^>]*)>([\s\S]+?)<\/script>/
    , white = /\s+/g
    , closeTags = />\s+</g
    , jsp = require('uglify-js').parser
    , pro = require('uglify-js').uglify
    , uglify = function (src) {
        try {
          var ast = jsp.parse(src)
          ast = pro.ast_squeeze(ast)
          return pro.gen_code(ast)
        }
        catch (ex) {
          return src
        }
      }
  return function (doc) {
    if (!minifyViews) return doc
    return doc.trim().replace(/ +/g, ' ').split(r).map(function (p, i, m) {
      return (m = p.match(scr)) ? '<script' + m[1] + '>' + uglify(m[2]) + '</script>' : p.replace(white, ' ')
    }).join('').replace(closeTags, '><')
  }
}()

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory()
  }
  catch (ex) {
    return false
  }
}

module.exports.createApp = function (baseDir, configuration, options) {
  configuration = configuration || {}
  options = options || {}

  var appDir = path.join(baseDir, '/app')
    , fileCache = {}
    , objCache = {}
    , pathCache = {}
    , updateCaches = v(paths).each(function (key, val) {
        fileCache[val] = {}
        objCache[val] = {}
        pathCache[val] = {}
      })
    , partialCache = {}
    , listingCache = {}
    , appDirs = [appDir].concat(v(function () {
        var dir = appDir + '/modules'
        return path.existsSync(dir) ? fs.readdirSync(dir) : []
      }()).map(function (dir) {
        return appDir + '/modules/' + dir
      }))
    , app = express.createServer()
    , fileExists = function (filename) {
        // We check for file existence this way so that our lookups are case sensitive regardless of the underlying filesystem.
        var dir = path.dirname(filename)
          , base = path.basename(filename)
        if (!listingCache[dir]) listingCache[dir] = path.existsSync(dir) ? fs.readdirSync(dir) : []
        return listingCache[dir].indexOf(base) !== -1
      }
    , loadFile = function (subdir, name, p) {
        if (typeof(fileCache[subdir][name]) !== 'undefined') return fileCache[subdir][name]
        var pathname = name.replace(/\./g, '/')
        var dir = v.find((p ? [p] : appDirs), function (dir) {
          var filename = dir + '/' + subdir + '/' + pathname + '.js'
          if (!fileExists(filename)) return false
          fileCache[subdir][name] = require(filename)(app, (configuration[subdir] && configuration[subdir][name] ? configuration[subdir][name] : {}))
          pathCache[subdir][name] = dir === appDir ? [appDir] : [dir, appDir]
          return true
        })
        if (!dir) throw new Error('Unable to find ' + subdir + '/' + pathname)

        return fileCache[subdir][name]
      }
    , loadClass = function (subdir, name, localName, definitionOnly) {
        if (definitionOnly) return loadFile(subdir, name)
        if (!objCache[subdir][name]) {
          var File = loadFile(subdir, name)
          objCache[subdir][name] = new File(localName, pathCache[subdir][name])
          objCache[subdir][name]._paths = pathCache[subdir][name]

          if (subdir === paths.MODELS) app.emit('createModel', localName, objCache[subdir][name])
          else if (subdir === paths.SERVICES) app.emit('createService', localName, objCache[subdir][name])
          else if (subdir === paths.CONTROLLERS) app.emit('createController', localName, objCache[subdir][name])
          //not emitting an event for helpers here as we never actually instantiate a helper
        }
        return objCache[subdir][name]
      }
    , mountPublicDir = function (dir) {
      var directory = dir + '/public'
      fileExists(directory) && app.use(express.static(directory))
    }

  app.set('base_dir', appDir)
  app.set('public', appDir + '/public')
  v(appDirs).each(mountPublicDir)

  app.controllers = {
    Base: require('./BaseController')(app)
  }

  app.addModulePath = function (dir) {
    appDirs.push(dir)
    mountPublicDir(dir)
  }

  app.getModulePaths = function () {
    return appDirs
  }

  app.mount = function () {
    var router = require('./router')
      , self = this

    v.each(appDirs, function (dir) {
      var filename = dir + '/config/routes.js'
      if (!fileExists(filename)) return
      router.init(self, require(filename)(self))
    })
    // static directory server

    router.init(this, {
      root: [['get', /(.+)/, 'Static']]
    })
  }

  app.prefetch = function (options) {
    var self = this

    v(paths).each(function (key, type) {
      v.each(appDirs, function (dir) {
        var d = dir + '/' + type
        if (!isDirectory(d)) return
        v.each(fs.readdirSync(d), function (file) {
          if (isDirectory(d + "/" + file)) return
          if (file.charAt(0) == '.') return
          if (file.substr(file.length - 3) === '.js') file = file.substr(0, file.length - 3)
          loadFile(type, file, dir)
        })
      })
    })
  }

  /**
   * Finds all partial templates relative to the provided view directory, stopping once the root
   * directory has been reached.
   *
   * All templates are added from the /partials/ folder within the current view directory.  We then
   * move to the parent directory and add any partials from it's /partials/ folder that don't conflict
   * with ones already added. We then move to the next parent directory and so on until we reach the
   * application root.
   *
   * This allows views to use common templates, and be able to override sub-templates.
   *
   * Example: consider the following directory structure:
   *   app/
   *       views/
   *           partials/
   *               user-details.html  - contains {{> user-link}})
   *               user-link.html
   *           search/
   *               results.html - contains {{> user-details}}
   *               partials/
   *                   user-link.html
   *           post/
   *               post.html  - contains {{> user-details}}
   *
   * The partials for app/views/search will contain:
   *   app/views/search/partial/user-link.html
   *   app/views/partial/user-details.html
   *
   * The partials for app/views/post will only contain app/views/partials/%
   *
   *
   * TODO: This uses synchronous filesystem APIs. It should either be performed at start up
   * for all controllers or else switched to use async APIs.
   */
  app.getPartials = function (viewDir) {
    var rootDir = app.set('base_dir')
    var viewSuffix = '.' + app.set('view engine')

    if (!partialCache[viewDir]) {

      if (path.relative(rootDir, viewDir).indexOf('../') != -1) {
        throw new Error('View directories must live beneath the application root.')
      }

      var partials = {}
      while (viewDir != rootDir) {
        var partialDir = path.resolve(viewDir, 'partials')
        try {
          fs.readdirSync(partialDir).forEach(function (file) {
            // Ignore hidden files and files that don't have the right extension.
            if (file.charAt(0) == '.') return
            if (file.substr(-viewSuffix.length) != viewSuffix) return

            // Remove the suffix, such that /partials/something.html can be used as {{> something}}
            var partialName = file.substr(0, file.length - viewSuffix.length)

            // If the map already contains this partial it means it has already been specified higher
            // up the view hierarchy.
            if (!partials[partialName]) {
              var partialFilename = path.resolve(partialDir, file)
              try {
                var partialContent = fs.readFileSync(partialFilename, 'utf8')
                partials[partialName] = hogan.compile(minify(partialContent))
              } catch (e) {
                console.log('Unable to compile partial', partialFilename, e)
              }
            }
          })
        } catch (e) {
          // Only log errors if they are not a "no such file or directory" error, since we expect
          // those to happen. (Saves us an fs.statSync.)
          if (e.code != 'ENOENT') console.log('Unable to read partials directory', partialDir, e)
        }
        viewDir = path.resolve(viewDir, '../')
      }
      partialCache[viewDir] = partials
    }

    // Note: This does more work than is necessary, since common parents of views will
    // be hit once for each view. If this turns out to be problematic we can cache at
    // intermediate folders as well.

    return partialCache[viewDir]
  }

  /**
   * Get a service instance or class
   *
   * @param {String} name the name of the service
   * @param {Boolean} definitionOnly whether to just grab the class or to grab an actual
   *     instance
   * @return {Object} a service class or instance
   */
  app.getService = function (name, definitionOnly) {
    return loadClass(paths.SERVICES, name + filenameSuffixes.SERVICES, name, definitionOnly)
  }

  /**
   * Get a controller instance or class
   *
   * @param {String} name the name of the controller
   * @param {Boolean} definitionOnly whether to just grab the class or to grab an actual
   *     instance
   * @return {Object} a controller class or instance
   */
  app.getController = function (name, definitionOnly) {
    if (app.controllers[name]) {
      return definitionOnly ? app.controllers[name] : new app.controllers[name](name, [])
    }
    else {
      return loadClass(paths.CONTROLLERS, name + filenameSuffixes.CONTROLLERS, name, definitionOnly)
    }
  }

  /**
   * Get a model instance or class
   *
   * @param {String} name the name of the model
   * @param {Boolean} definitionOnly whether to just grab the class or to grab an actual
   *     instance
   * @return {Object} a model class or instance
   */
  app.getModel = function (name, definitionOnly) {
    return loadClass(paths.MODELS, name + filenameSuffixes.MODELS, name, definitionOnly)
  }

  /**
   * Get a helper
   *
   * @param {String} name of the helper
   * @return {Object} a helper instance
   */
  app.getHelper = function (name) {
    return loadFile(paths.HELPERS, name + filenameSuffixes.HELPERS)
  }

  /**
   * Override the existing cached version of a service
   *
   * @param {String} name the name of the service
   * @param {Object} instance the service instance
   */
  app.setService = function (name, instance) {
    objCache[paths.SERVICES][name + filenameSuffixes.SERVICES] = instance
  }

  /**
   * Override the existing cached version of a controller
   *
   * @param {String} name the name of the controller
   * @param {Object} instance the controller instance
   */
  app.setController = function (name, instance) {
    objCache[paths.CONTROLLERS][name + filenameSuffixes.CONTROLLERS] = instance
  }

  /**
   * Override the existing cached version of a model
   *
   * @param {String} name the name of the model
   * @param {Object} instance the model instance
   */
  app.setModel = function (name, instance) {
    objCache[paths.MODELS][name + filenameSuffixes.MODELS] = instance
  }

  app.controllers.Static = require('./StaticController')(app)

  return app
}

module.exports.engine = {
  compile: function (source, options) {
    if (typeof source !== 'string') return source
    source = minify(source)
    return function (options) {
      options.locals = options.locals || {}
      options.partials = options.partials || {}
      if (options.body) options.locals.body = options.body
      for (var i in options.partials) {
        if (v.is.fun(options.partials[i].r)) continue
        try {
          options.partials[i] = hogan.compile(options.partials[i])
        } catch (e) {
          console.log("Unable to compile partial", i, e)
        }
      }
      return hogan.compile(source, options).render(options.locals, options.partials)
    }
  }
}
