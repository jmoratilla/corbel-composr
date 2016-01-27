'use strict'

var corbelConnection = require('./corbelConnection')
var amqp = require('amqplib')
var uuid = require('uuid')
var ComposrError = require('./ComposrError')
var config = require('./config')
var logger = require('../utils/composrLogger')
var hub = require('./hub')

function Worker (engine) {
  var that = this;
  this.connUrl = 'amqp://' + encodeURIComponent(config('rabbitmq.username')) + ':' + encodeURIComponent(config('rabbitmq.password')) + '@' + config('rabbitmq.host') + ':' + config('rabbitmq.port') + '?heartbeat=30'
  this.workerID = uuid.v4()
  this.engine = engine;
  this.connectionStatus = false
}

Worker.prototype.phraseOrSnippet = function (type) {
  return type === corbelConnection.PHRASES_COLLECTION
}

Worker.prototype.isPhrase = function (type) {
  return type === corbelConnection.PHRASES_COLLECTION
}

Worker.prototype.isSnippet = function (type) {
  return type === corbelConnection.SNIPPETS_COLLECTION
}

Worker.prototype._doWorkWithPhraseOrSnippet = function (itemIsPhrase, id, action) {
  var domain = id.split('!')[0]
  var that = this
  switch (action) {
    case 'DELETE':
      logger.debug('WORKER triggered DELETE event', id, 'domain:' + domain)
      if (itemIsPhrase) {
        this.engine.composr.Phrases.unregister(domain, id)
        this.engine.composr.removePhrasesFromDataStructure(id)
      } else {
        this.engine.composr.Snippets.unregister(domain, id)
        this.engine.composr.removeSnippetsFromDataStructure(id)
      }
      // ch.ack(msg)
      break

    case 'CREATE':
    case 'UPDATE':
      logger.debug('WORKER triggered CREATE or UPDATE event', id, 'domain:' + domain)
      var promise
      var itemToAdd

      if (itemIsPhrase) {
        promise = this.engine.composr.loadPhrase(id)
      } else {
        promise = this.engine.composr.loadSnippet(id)
      }
      promise
        .then(function (item) {
          logger.debug('worker item fetched', item.id)
          itemToAdd = item
          if (itemIsPhrase) {
            return that.engine.composr.Phrases.register(domain, item)
          } else {
            return that.engine.composr.Snippets.register(domain, item)
          }
        })
        .then(function (result) {
          if (result.registered === true) {
            if (itemIsPhrase) {
              that.engine.composr.addPhrasesToDataStructure(itemToAdd)
            } else {
              that.engine.composr.addSnippetsToDataStructure(itemToAdd)
            }
          }
          logger.debug('worker item registered', id, result.registered)
        })
        .catch(function (err) {
          logger.error('WORKER error: ', err.data.error, err.data.errorDescription, err.status)
        })
      break

    default:
      logger.warn('WORKER error: wrong action ', action)
  }
}

Worker.prototype.doWork = function (ch, msg) {
  if (msg.fields.routingKey === config('rabbitmq.event')) {
    var message
    try {
      message = JSON.parse(msg.content.toString('utf8'))
    } catch (error) {
      // ch.nack(error, false, false)
      throw new ComposrError('error:worker:message', 'Error parsing message: ' + error, 422)
    }
    var type = message.type
    if (this.isPhrase(type) || this.isSnippet(type)) {
      var itemIsPhrase = this.isPhrase(type)
      logger.debug('WORKER ' + itemIsPhrase ? 'phrases' : 'snippet' + ' event:', message)
      this._doWorkWithPhraseOrSnippet(itemIsPhrase, message.resourceId, message.action)
    }
  }
}

Worker.prototype.createChannel = function (conn) {
  var that = this
  var queue = config('serverName') + that.workerID
  var exchange = 'eventbus.exchange'
  var pattern = ''

  return conn.createChannel()
    .then(function (ch) {
      return ch.assertQueue(queue, {
        durable: false,
        autoDelete: true
      })
        .then(function () {
          return ch.bindQueue(queue, exchange, pattern)
        })
        .then(function () {
          ch.consume(queue, function (message) {
            // Added callback function in case we need to do manual ack of the messages
            that.doWork(ch, message)
          },
            Object.create({
              noAck: true
            }))
        })
    })
}

Worker.prototype._closeConnectionSIGINT = function (connection) {
  var that = this;
  logger.warn('RABBIT closing connection')
  process.once('SIGINT', function () {
    connection.close()
    that.connectionStatus = false
    process.exit()
  })
}

Worker.prototype._closeConnection = function (connection) {
  var that = this;
  logger.warn('RABBIT closing connection')
  connection.close(function () {
    that.connectionStatus = false
    process.exit(1)
  })
}

Worker.prototype._connect = function () {
  return amqp.connect(this.connUrl)
}

Worker.prototype.retryInit = function () {
  var that = this
  return setTimeout(function () {
    that.init()
  }, config('rabbitmq.reconntimeout'))
}

Worker.prototype.init = function () {
  var conn
  var that = this
  logger.info('Creating worker with ID', that.workerID)

  that._connect()
    .then(function (connection) {
      // Bind connection errror
      connection.on('error', function (error) {
        logger.error('RABBIT', error)
        that.connectionStatus = false
        that.init()
      })

      conn = connection
      that._closeConnectionSIGINT(connection)
      that.createChannel(connection)
        .then(function () {
          that.connectionStatus = true
          logger.info('Worker up, with ID', that.workerID)
          // emit loaded worker
          hub.emit('load:worker')
        })
        .catch(function (error) {
          logger.error('WORKER error ', error, 'with ID', that.workerID)
          if (conn) {
            that._closeConnection(conn)
          }
        })
    })
    .then(null, function (err) {
      logger.error('Worker error %s with ID : %s', err, that.workerID)
      that.retryInit()
    })
}

module.exports = Worker
