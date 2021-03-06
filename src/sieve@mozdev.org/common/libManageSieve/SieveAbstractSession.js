/* 
 * The content of this file is licensed. You may obtain a copy of
 * the license at https://github.com/thsmi/sieve/ or request it via 
 * email from the author.
 * 
 * Do not remove or change this comment. 
 * 
 * The initial author of the code is:
 *   Thomas Schmid <schmid-thomas@gmx.net>
 */

// Enable Strict Mode
"use strict";

(function(exports) {
	
	/* global SieveNoopRequest */
	/* global SieveCapabilitiesRequest */
  /* global SieveSaslPlainRequest */
	/* global SieveSaslCramMd5Request */
	/* global SieveSaslScramSha1Request */
	/* global SieveSaslExternalRequest */
	/* global SieveSaslLoginRequest */
	/* global SieveInitRequest */
	/* global Sieve */
	/* global SieveLogoutRequest */
	/* global SieveStartTLSRequest */
	
  /**
   * This class pools and caches concurrent connections (Channel) to an destinct 
   * remote server (Session).
   * Furthermore it's a wrapper around the Sieve object. It implements
   * the login/logout process, a watchdog, an hartbeat an much more. 
   * 
   * A session can contain arbitary connections, but there will be only one 
   * "physical" link to the server. All channels share the session's link.
   * 
   * @param {SieveAccount} account
   *   an reference to a sieve account. this is needed to obtain login informations.
   *   
   */
  function SieveAbstractSession(account, logger)
  {
    this.idx = 0;
  
    // Load Account by ID
    this.account = account;
    this.logger = logger;
      
    // 0 = Offline 1 = Connecting 2 = connected 3= disconnecting 
    this.state = 0;
  }
	  
  SieveAbstractSession.prototype = 
  {
    onIdle: function ()
    {
    	this.logger.log("Sending keep alive packet...", (1 << 2));
    	
      // as we send a keep alive request, we don't care
      // about the response...
      var request = null;
      
      if (this.sieve.getCompatibility().noop)
        request = new SieveNoopRequest();
      else
        request = new SieveCapabilitiesRequest();
      
      this.sieve.addRequest(request);
    },
  
    onInitResponse: function(response)
    {
      // establish a secure connection if TLS ist enabled and if the Server ...
      // ... is capable of handling TLS, otherwise simply skip it and ...
      // ... use an insecure connection
      
      if (!this.account.getHost().isTLSEnabled())
      {
        this.onAuthenticate(response);
        return;
      }
      
      if (!response.getTLS() && !this.account.getHost().isTLSForced())
      {
        this.onAuthenticate(response);
        return;
      }
      
      this.sieve.setPaused(true);
      var request = new SieveStartTLSRequest();
      request.addStartTLSListener(this);
      request.addErrorListener(this);
      
      this.sieve.addRequest(request);
    },
    
    onAuthenticate: function(response)
    { 
      // update capabilites
      this.sieve.setCompatibility(response.getCapabilities());
      
      this._invokeListeners("onChannelStatus",3,"progress.authenticating");
        
      var account =  this.account;
      
      // Without a username, we can skip the authentication 
      if (account.getLogin().hasUsername() === false)
      {
        this.onLoginResponse(null);
        return;
      }
      
  
      // Notify the listener to display capabilities. We simply pass the response... 
      // ... to the listener. So the listener can pick whatever he needs.
      this.sieve.extensions = response.getExtensions();    
      this._invokeListeners("onChannelStatus",7,response);
  
      // We have to figure out which ist the best SASL Mechanism for the login ...
      // ... therefore we check first whether a mechanism is forced by the user ...
      // ... if no one is specified, we follow the rfc advice and use the first 
      // .... mechanism listed in the capability response we support.
      
      var mechanism = [];        
      if (account.getSettings().hasForcedAuthMechanism())
        mechanism = [account.getSettings().getForcedAuthMechanism()];      
      else
        mechanism = response.getSasl();
  
      // ... translate the SASL Mechanism into an SieveSaslLogin Object ...      
      var request = null;
      while((mechanism.length > 0) && (request == null))
      {
        // remove and test the first element...
        switch (mechanism.shift().toUpperCase())
        {
          case "PLAIN":
            request = new SieveSaslPlainRequest();
            break;
            
          case "CRAM-MD5":
            request = new SieveSaslCramMd5Request();
            break;
            
          case "SCRAM-SHA-1":
            request = new SieveSaslScramSha1Request();
            break;
          
          case "EXTERNAL":
            request= new SieveSaslExternalRequest();
            break;
            
          case "LOGIN":
            // we use SASL LOGIN only as last resort...
            // ... as suggested in the RFC.        
            if (mechanism.length > 0)
            {
              mechanism.push("LOGIN");
              break;
            }
            request = new SieveSaslLoginRequest();      
            break;
        }      
      }
  
      if (!request)
      {
        this.disconnect(false,2,"error.sasl");
        return;
      }
      
      request.addErrorListener(this);
          
      request.setUsername(account.getLogin().getUsername());
      
      // SASL External has no passwort it relies completely on SSL...
      if (request.hasPassword()) {
      	
        var password = account.getLogin().getPassword();
      
        if (password == null)
        {
          this.disconnect(false,2,"error.authentication");
          return;
        }
      
        request.setPassword(password);
      }
      
      request.addSaslListener(this);
      
      
      // check if the authentication method supports proxy authorization...
      if (request.isAuthorizable())
      {
        // ... if so retrieve the authorization identity   
        var authorization = account.getAuthorization().getAuthorization();
        if (authorization == null)
        {
          this.disconnect(false,2,"error.authentication");
          return;
        }
        
        if (authorization !== "")
          request.setAuthorization(authorization);
      }
       
      this.sieve.addRequest(request);    
    },
  
    onStartTLSCompleted : function(response)
    { 
      var that = this;
    
  
      
      var lEvent = 
      {
        onCapabilitiesResponse: function(response)
        {        
          that.onAuthenticate(response); 
        }
      };
      
      // explicitely request capabilites
      var request = new SieveCapabilitiesRequest();
      request.addCapabilitiesListener(lEvent);
      
      this.sieve.addRequest(request);
      
      // With a bugfree server we endup with two capability request, one 
      // implicit after startTLS and one explicite from capbilites. So we have
      // to consume one of them silently...
      this.sieve.addRequest(new SieveInitRequest(),true);
    
      this.sieve.setPaused(false);
    },
    
    onStartTLSResponse : function(response)
    { 
      var that = this;
      this.sieve.startTLS( function () { that.onStartTLSCompleted(response); });
    },
  
    onSaslResponse: function(response)
    {
      this.onLoginResponse(response);
    },
    
    onLoginResponse: function(response)
    {
      // We are connected...
      this.state = 2;
      this._invokeListeners("onChannelCreated",this.sieve);
    },
    
    addListener: function(listener)
    {
      if (!this.listeners)
        this.listeners = [];
        
      this.listeners.push(listener);
      
    },
    
    removeListener: function(listener)
    {
      if (!this.listeners)
        return;
  
      for (var i=0; i< this.listeners.length; i++)
        if (this.listeners[i] == listener)
          this.listeners.splice(i,1);
   
    },
    
    _hasListeners: function(callback)
    {
      if (!this.listeners)
        return false;
        
      for (var i=0; i< this.listeners.length; i++)
       if (this.listeners[i][callback])
         return true;      
    },
    
    _invokeListeners: function(callback,arg1, arg2)
    {
      if (!this.listeners)
        return false;
  
      // the a callback function might manipulate our listeners...
      // ... so we need to cache them before calling...      
      var iterator = [];
      for (var i=0; i< this.listeners.length; i++)
        if (this.listeners[i][callback])
          iterator.push(this.listeners[i]);
         
      if (!iterator.length)
      {
        if (this.logger.isLoggable((1 << 4)))
          this.logger.log("No Listener for "+callback+"\n"+this.listeners.toString());
          
        return;
      }
      
      this.logger.log("Invoking Listeners for "+callback+"\n", (1 << 4));
        
      while (iterator.length)
      {
        var listener = iterator.pop();
        listener[callback].call(listener,arg1,arg2);
      }
        
    },
  
    /** @private */  
    onLogoutResponse: function(response)
    {
      this.disconnect(true);
    },
    
    /**
     * Called by the sieve object in case we received an BYE response.
     * @param {} response
     */
    onByeResponse: function(response)
    {
      // The server is going to disconnected our session nicely...
      var code = response.getResponseCode();
          
      // ... we most likely received a referal 
      if (code.equalsCode("REFERRAL"))
      {
        // The referal should be fully transparent to the session, so we cannot...
        // ... call this.disconnect(true) here as it flushes/closes all our channels...
        if (this.sieve)
          this.sieve.disconnect();
  
        // we are disconnected...
        this.sieve = null;
        this.state = 0;
        
  
        this.logger.log("Referred to Server: "+code.getHostname(), (1 << 4));
        this.logger.log("Migrating Channel: ["+this.channels+"]", (1 << 4));
        
        this.connect(code.getHostname(), code.getPort());      
        return;
      }
      
      // ... as the server must terminate the connection after sending a ...
      // ... bye response, we should also disconnect nicely which means in this...
      // ... case without a logout request.
      this.disconnect(true);
      
      // ... it's either a timeout or we tried the wrong password...
      // ... the best we can do is to report an error.
      this.onError(response);
    },
    
    /** @private */
    onError: function(response)
    {
      this.logger.log("OnError: "+response.getMessage());
      this.disconnect(false,4,response.getMessage());
    },
  
    /** @private */
    onTimeout: function(message)
    {
      this._invokeListeners("onTimeout",message);
    },
    
    /**
     * This listener is called when the conenction is lost or terminated by the server
     * and the session is no more usable. It ensures that everything is disconnected
     * correctly.
     **/
    onDisconnect: function()
    {    
      this.logger.log("On Server Disconnect:  ["+this.channels+"]", (1 << 4));
          
      this._invokeListeners("onDisconnect");  
      this.disconnect(true);
    },
    
    /**
     * Connects to a remote Sieve server. 
     * 
     * It warps the complex login process. For example it automatically requests 
     * for a password, picks an authentication mechanism and starts a secure 
     * connection.
     * 
     * You get notification on the login status through the listener. 
     *
     * @param {String} hostname - optional
     *   overrides the default hostname supplied by the account. This is needed
     *   for referrals and similar stuff.
     * @param {int} port - optional
     *   overrides the default port supplied by the account.
     */    
    connect : function(hostname,port)
    { 
      // set state to connecting...
      this.state = 1;
      
      
      this.sieve = new Sieve(this.logger);
      
      // Step 1: Setup configure settings                   
      this.sieve.addListener(this);
    
      // TODO Load Timeout interval from account settings...    
      if (this.account.getSettings().isKeepAlive())
        this.sieve.setKeepAliveInterval(this.account.getSettings().getKeepAliveInterval());    
      
      // Step 2: Initialize Message Queue...
      var request = new SieveInitRequest();
      request.addErrorListener(this);
      request.addInitListener(this);
      this.sieve.addRequest(request);   
  
      // Step 3: Connect...
      if (hostname == null)
        hostname = this.account.getHost().getHostname();
        
      if (port == null)
        port = this.account.getHost().getPort();
        
      this.sieve.connect(
          hostname,port,
          this.account.getHost().isTLSEnabled(),
          this,
          this.account.getProxy().getProxyInfo());    
    },
    
    disconnect : function(force, id, message)
    {
      // update state we are now disconnecting...
      this.state = 3;
      
      // at first we update the status, so that the user ...
      // ... knows what happened.
      if (id)
        this._invokeListeners("onChannelStatus",id,message);
  
      // Skip if the connection already closed...
      if (!this.sieve)
      {
        this.state = 0;
        return;
      }
      
      // ... we always try to exit with an Logout request...      
      if (!force && this.sieve.isAlive())
      {
        var request = new SieveLogoutRequest();
        request.addLogoutListener(this);
        /*request.addErrorListener(levent);*/
        this.sieve.addRequest(request);
        
        return;
      }
      
      // ... but this obviously is not always usefull
      this.sieve.disconnect();      
      this.sieve = null;
      
      this.channels = null;
      
      // update state: we are disconnected
      this.state = 0;
        
      return;
    },
  
    isConnecting : function()
    {
      return (this.state === 1);
    },
  
    isConnected : function()
    {
      return (this.state === 2);
    },
  
    isDisconnecting : function()
    {
      return (this.state === 3);
    },
    
    isDisconnected : function()
    {
      return (this.state === 0);
    },
      
    /**
     * Requests a channel for to this session. After use you have to revoke it via
     * "removeChannel", this will close the channel. Otherwise the connection
     * to the remote server might stay open. 
     *    
     * @return {} An unique Identifier
     */
    addChannel : function()
    {
      
      if (!this.channels)
        this.channels = [];
        
      var cid = "cid="+(this.idx++);
      
      this.channels.push(cid);     
       
      this.logger.log("Channel Added: "+cid+" ["+this.channels+"]", (1 << 4));
       
      return cid;
    },
      
    /**
     * Closes and Invalidates a channel. In case all channels of a session are
     * closed, the connection to the remote server will be terminated. That's why
     * there's no close session command. Thus always close your channels.
     * 
     * This Method does not throw an Exception, even if you pass an invalid 
     * session identifier! So it's save to call this method if you are unsure
     * if you already closed a channel.
     *  
     * @param {} cid
     *   The unique Identifier of the channel which should be closed and invalidated.
     * @return {Boolean}
     *   return true if the channel could be closed and false if not. A "false" 
     *   means the identifier is invalid. 
     */
    removeChannel : function(cid)
    { 
      if (!this.channels)
        return false;
        
      var i = this.channels.indexOf(cid);
      if (i == -1)
        return false;
        
      this.channels.splice(i, 1);
      
      this.logger.log("Channel Closed: "+cid+" ["+this.channels+"]", (1 << 4));
       
      return true;
    },
    
    /**
     * Checks if the session has open/registered channels.
     * @return {Boolean}
     *   returns true incase the session has open channels. Otherwise false.
     */
    hasChannels : function()
    { 
      if ((this.channels) && (this.channels.length > 0))
        return true;
        
      return false;
    },
    
    /**
     * Checks if a channel is registed with this session
     * @param {} cid
     *   the channels unique identifier
     * @return {Boolean}
     *   returns false in case the channel identifier is not registered with 
     *   this session's object.
     */
    hasChannel : function(cid)
    {
      return (this.channels.indexOf(cid) == -1)?false:true;    
    }

  };

  exports.SieveAbstractSession = SieveAbstractSession;
})(this);