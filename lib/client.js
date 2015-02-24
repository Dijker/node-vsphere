"use strict";
/*
  client.js

  Implements the vsphere Client() class

*/

var EventEmitter = require('events').EventEmitter,
  util = require('util'),
  nvs = require('node-vsphere-soap'),
  types = require('./types'),
  Joi = require('joi'),
  joiModel = require('joi-model'),
  _ = require('lodash');

// Client class
function Client( hostname, username, password, sslVerify) {

  var self = this;

  EventEmitter.call(this);

  this.serviceContent = undefined;

  var vc = new nvs.Client( hostname, username, password, sslVerify);
  vc.once('ready', function() {
    self.serviceContent = vc.serviceContent;
    self.emit('ready');
  });

  this.vc = vc;

  return this;

}

util.inherits(Client, EventEmitter);

// run arbitrary vSphere API command
Client.prototype.runCommand = function( command, args) {

  return this.vc.runCommand( command, args );

};

Client.prototype.getMORefsInContainerByType = function( MORefFolder, type ) {

  return this.getMORefsInContainerByTypeAndPropertyArray( MORefFolder, type, undefined );

};

Client.prototype.getMORefsInContainerByTypeAndPropertyArray = function( MORefFolder, type, propertyArray ) {

  var viewManager = this.vc.serviceContent.viewManager;
  var propertyCollector = this.vc.serviceContent.propertyCollector;

  var containerView;

  var emitter = new EventEmitter;
  var self = this;

  this.vc.runCommand('CreateContainerView', { _this: viewManager,
                                        container: MORefFolder,
                                        type: type,
                                        recursive: true})
    .on('result', function(result) {

      containerView = result.returnval;

      var propertySpec = {};

      if( propertyArray && typeof propertyArray === 'object' && propertyArray.length > 0) {
        propertySpec = {
          attributes: {'xsi:type': 'PropertySpec'},
          type: type,
          all: false,
          pathSet: propertyArray
        };
      } else if( propertyArray && typeof propertyArray === 'string') {
        propertySpec = {
          attributes: {'xsi:type': 'PropertySpec'},
          type: type,
          all: false,
          pathSet: [ propertyArray ]
        };
      } else {
        propertySpec = {
          attributes: {'xsi:type': 'PropertySpec'},
          type: type,
          all: true
        };
      }
      Joi.validate(propertySpec, types.schemaPropertySpec, function(err, value) {
        if(err) {
          emitter.emit('error', err);
          return;
        }
      });

      var traversalSpec = {
        attributes: {'xsi:type': 'TraversalSpec'},
        type: 'ContainerView',
        path: 'view',
        skip: false
      };
      Joi.validate(traversalSpec, types.schemaTraversalSpec, function(err, value) {
        if(err) {
          emitter.emit('error', err);
          return;
        }
      });

      var objectSpec = {
        attributes: {'xsi:type': 'ObjectSpec'},
        obj: containerView,
        skip: true,
        selectSet: [ traversalSpec ]
      };
      Joi.validate(objectSpec, types.schemaObjectSpec, function(err, value) {
        if(err) {
          emitter.emit('error', err);
          return;
        }
      });

      var propertyFilterSpec = {
        attributes: {'xsi:type': 'PropertyFilterSpec'},
        propSet: [ propertySpec ],
        objectSet: [ objectSpec ]
      };
      Joi.validate(propertyFilterSpec, types.schemaPropertyFilterSpec, function(err, value) {
        if(err) {
          emitter.emit('error', err);
          return;
        }
      });

      self.vc.runCommand('RetrievePropertiesEx', { _this: propertyCollector, specSet: [ propertyFilterSpec ], options: {} })
        .once('result', function(result){
          emitter.emit('result', result);
        })
        .once('error', function(err){
          console.error('\nlast request : ' + self.vc.client.lastRequest + '\n');
          emitter.emit('error', err);
        });

    })
    .once('error', function(err){
      console.error(err);
      emitter.emit('error', err);
    });

  return emitter;
};

// this function returns information in the following format
/* [{ obj: { attributes: { type: 'VirtualMachine' }, '$value': '4' }, // this is a ManagedObjectReference
    name: 'testvm-win',
    powerState: 'poweredOff' }, ...]
*/
Client.prototype.getVMinContainerPowerState = function( MORefFolder ) {

  var self = this;

  var emitter = new EventEmitter;

  this.getMORefsInContainerByTypeAndPropertyArray( MORefFolder, 'VirtualMachine', 'summary')
    .once('result', function(result) {

      // if no vms, return empty set
      if( _.isEmpty(result)) {
        emitter.emit('result', []);
        return;
      }

      var data = result.returnval.objects;

      var resultArray = [];

      _.forEach(data, function(vm) {
        resultArray.push({
          obj: vm.obj,
          name: vm.propSet.val.config.name,
          powerState: vm.propSet.val.runtime.powerState
        });
        if( resultArray.length === data.length ) {
          emitter.emit('result',resultArray);
        }
      });
    })
    .once('error', function(err){
      console.error(err);
      emitter.emit('error', err);
    });

  return emitter;

};

/* TODO:
Client.prototype.getTaskInfoByMORef = function( MORefs )

*/

// ported from vSphere WS Java SDK
Client.prototype.waitForValues = function( MORef, filterProps, endWaitProps, expectedVals) {

  var self = this;
  var serviceContent = this.serviceContent;

  var emitter = new EventEmitter;

  if( ! _.isArray(filterProps) ) {
    filterProps = [ filterProps ];
  }
  if( ! _.isArray(endWaitProps) ) {
    endWaitProps = [ endWaitProps ];
  }  if( ! _.isArray(expectedVals) ) {
    expectedVals = [ expectedVals ];
  }

  // create propertyFilterSpec for upcoming createFilter command
  var objectSpec = {
    attributes: {'xsi:type': 'ObjectSpec'},
    obj: MORef,
    skip: false,
  };
  Joi.validate(objectSpec, types.schemaObjectSpec, function(err, value) {
    if(err) {
      emitter.emit('error', err);
      return;
    }
  });
  var propertySpec = {
    attributes: {'xsi:type': 'PropertySpec'},
    type: MORef.attributes.type,
    pathSet: filterProps
  };
  Joi.validate(propertySpec, types.schemaPropertySpec, function(err, value) {
    if(err) {
      emitter.emit('error', err);
      return;
    }
  });

  var propertyFilterSpec = {
    attributes: {'xsi:type': 'PropertyFilterSpec'},
    propSet: [ propertySpec ],
    objectSet: [ objectSpec ]
  };
  Joi.validate(propertyFilterSpec, types.schemaPropertyFilterSpec, function(err, value) {
    if(err) {
      emitter.emit('error', err);
      return;
    }
  });

  var version = "";
  var reached = false;

  this.runCommand('CreateFilter', { _this: this.serviceContent.propertyCollector, spec: propertyFilterSpec, partialUpdates: true })
  .once('result', function(result) {

    var filterSpecRef = result.returnval;
    var version = "";

    var found = false;

    var toCompare = {};
    var finalReturnVals = {};

    ( function waitForUpdates() {

      self.runCommand('WaitForUpdatesEx', { _this: self.serviceContent.propertyCollector, version: version, options: {} })
      .on('result', function(result) {
        if( _.isEmpty(result.returnval) || _.isEmpty(result.returnval.filterSet) ) {
          // console.log('empty result set');
          waitForUpdates();
        }
        version = result.returnval.version;

        var filterSetArray = result.returnval.filterSet;
        if( ! _.isArray(filterSetArray) ) {
          filterSetArray = [ result.returnval.filterSet ];
        }
        
        _.forEach( filterSetArray, function( filterSet ) {
          var objSetArray = filterSet.objectSet;
          if( ! _.isArray(objSetArray) ) {
            objSetArray = [ objSetArray ];
          }
          _.forEach( objSetArray, function( objSet ) {
            if( objSet.kind == 'modify' ||
              objSet.kind == 'enter' ||
              objSet.kind == 'leave' ) {
              var changeSetArray = objSet.changeSet;
              if( ! _.isArray(changeSetArray) ) {
                changeSetArray = [ changeSetArray ];
              }

              _.forEach( changeSetArray, function( changeSet ) {

                _.forEach( endWaitProps, function(prop) {
                  if( changeSet['name'].indexOf(prop) >= 0) {
                    if(changeSet['op'] == 'remove') {
                      toCompare[prop] = "";
                    } else {
                      toCompare[prop] = changeSet.val;
                    }
                  }
                });

                _.forEach( filterProps, function(prop) {
                  if( changeSet['name'].indexOf(prop) >= 0) {
                    if(changeSet['op'] == 'remove') {
                      finalReturnVals[prop] = "";
                    } else {
                      finalReturnVals[prop] = changeSet.val;
                    }
                  }
                });
              });
            } // end if
          });

          var compared = 0;
          while(compared < _.keysIn( toCompare ).length && !found) {
            
            for( var key in toCompare) {
              //console.log('value to compare : ' + key);
              if( expectedVals.indexOf(toCompare[key]['$value']) > -1 && !found ) {
                found = true;
              }
              compared++;
              if( compared == _.keysIn( toCompare ).length && !found) {
                // no relevant updates yet -- check again
                waitForUpdates();
              }
            }
          }

          if(found) {
            self.runCommand('DestroyPropertyFilter', { _this: filterSpecRef })
            .once('result', function() {

              emitter.emit('result', finalReturnVals);        
            })
            .once('error', function(err) {
              emitter.emit('error', err);
            });
          }

        });
      })
      .on('error', function(err) {
        console.error(err);
        emitter.emit('error',err);
      })

    }()); // end waitForUpdates()
  
  })
  .once('error', function(err) {
    console.error(err);
    emitter.emit('error',err);
  });

  return emitter;

};

Client.prototype.powerOnVMByMORef = function( MORefs ) {

  var self = this;
  var emitter = new EventEmitter;

  if( !MORefs || _.isEmpty(MORefs)) {
    emitter.emit('error', 'No ManagedObjectReference(s) given!');
    return;
  }

  // if one VM
  if( MORefs && !MORefs.length ) {
    this.runCommand('PowerOnVM_Task', { _this: MORefs })
    .once('result', function(result){
      var taskMORef = result.returnval;

      console.log('task result: ' + util.inspect(taskMORef, {depth: null}));

      // query task status
      self.waitForValues( taskMORef, ['info.state','info.error'], 'state', ['success','error'])
      .once('result', function( result ) {
        console.log('final result : ' + result);
        if(result['info.error'] == undefined) {
          emitter.emit('result', result['info.state'] );
        } else {
          emitter.emit('error', result['info.error'] );
        }
      })
      .once('error', function( err ) {
        console.error(err);
      });
    })
    .once('error', function(err){
      console.error(err);
      emitter.emit('error',err);
    });
  } else {
    // if multiple VMs
    var resultArray = [];

    _.forEach(MORefs, function(MORef) {
      this.runCommand('PowerOnVM_Task', { _this: MORef })
      .once('result', function(result){
        var taskMORef = result.returnval;

        self.waitForValues( taskMORef, ['info.state','info.error'], 'state', ['success','error'])
        .once('result', function( result ) {
          console.log('final result : ' + result);
          if( result['info.error'] == undefined ) {
            resultArray.push( MORef, result['info.state'] );
          } else {
            resultArray.push( MORef, result['info.error'] );
          }
          if(resultArray.length === MORefs.length) {
            emitter.emit('result', resultArray);
          } 
        })
        .once('error', function( err ) {
          console.error(err);
        });
      })
      .once('error', function(err){
        console.error(err);
        emitter.emit('error',err);
      });
    });

  }

  return emitter;
};

/*
Client.prototype.powerOnVM = function( name ) {


};
*/

exports.Client = Client;
