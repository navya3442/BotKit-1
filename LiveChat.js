var botId               = "st-2dfb9345-6f6e-5d7f-a70e-dc2926401e42";
var botName             = "test1";
var sdk                 = require("./lib/sdk");
var Promise             = require('bluebird');
var api                 = require('./LiveChatAPI.js');
var _                   = require('lodash');
var config              = require('./config.json');
var debug               = require('debug')("Agent");
var schedular           = require('node-schedule');
var { makeHttpCall } = require("./makeHttpCall");
var jwt = require("jwt-simple");
var _map                = {}; //used to store secure session ids //TODO: need to find clear map var
var userDataMap         = {};//this will be use to store the data object for each user
var userResponseDataMap = {};

/**
 * getPendingMessages
 *
 * @param {string} visitorId user id
 * @param {string} ssid session id of the live chat
 * @param {string} last message sent/received to/by agent 
*/
function getPendingMessages( visitorId, ssid, last_message_id){
    debug("getPendingMessages: %s %s ", visitorId, ssid);
    var licence_id = config.liveagentlicense;
    return api.getPendingMessages(visitorId, ssid,last_message_id, licence_id)
        .then(function(res){
            _.each(res.events, function(event){
                var data = userDataMap[visitorId];
                if(event.type === "message" && event.user_type !== "visitor"){
                    data.message = event.text;
                    data._originalPayload.message = data.text;
                    debug('replying ', event.text);
                    _map[visitorId].last_message_id = event.message_id;
                    return sdk.sendUserMessage(data, function(err){
                        console.log("err", err);
                    }).catch(function(e){
                        console.log(e);
                        debug("sending agent reply error", e);
                        delete userResponseDataMap[visitorId];
                        delete _map[visitorId];
                    });
                } else if (event.type==="chat_closed"){
                    console.log('chat_closed');
                    delete userResponseDataMap[visitorId];
                    delete _map[visitorId];
                    sdk.clearAgentSession(data);
                }
            });
        })
        .catch(function(e){
            console.error(e);
            delete userDataMap[visitorId];
            delete _map[visitorId];
        });
}

/*
 * Schedule a joob to fetch messages every 5 seconds 
 */
schedular.scheduleJob('*/5 * * * * *', function(){
    debug('schedular triggered');
    var promiseArr = [];
    _.each(_map, function(entry){
        promiseArr.push(getPendingMessages(entry.visitorId, entry.secured_session_id, entry.last_message_id));
     });
     return Promise.all(promiseArr).then(function(){
         debug('scheduled finished');
     }).catch(function(e) {
         debug('error in schedular', e);
     });
});
function gethistory(req, res){
    var userId = req.query.userId;
    var data = userDataMap[userId];
    
    if(data) {
        data.limit = 100;
        return sdk.getMessages(data, function(err, resp){
            if(err){
                res.status(400);
                return res.json(err);
            }
            var messages = resp.messages;
            res.status(200);
            return res.json(messages);
        });
    } else {
        var error = {
            msg: "Invalid user",
            code: 401
        };
        res.status(401);
        return res.json(error);
    }
}

/**
 * connectToAgent
 *
 * @param {string} requestId request id of the last event
 * @param {object} data last event data
 * @returns {promise}
 */
function connectToAgent(requestId, data, cb){
    var formdata = {};
    formdata.licence_id = config.liveagentlicense;
    formdata.welcome_message = "";
    var visitorId = _.get(data, 'channel.channelInfos.from');
    if(!visitorId){
        visitorId = _.get(data, 'channel.from');
    }
    userDataMap[visitorId] = data;
    data.message="An Agent will be assigned to you shortly!!!";
    sdk.sendUserMessage(data, cb);
    formdata.welcome_message = "Link for user Chat history with bot: "+ config.app.url +"/history/index.html?visitorId=" + visitorId;
    return api.initChat(visitorId, formdata)
         .then(function(res){
             _map[visitorId] = {
                 secured_session_id: res.secured_session_id,
                 visitorId: visitorId,
                 last_message_id: 0
            };
        });
}

/*
 * onBotMessage event handler
 */
function onBotMessage(requestId, data, cb){
    debug("Bot Message Data",data);
    var visitorId = _.get(data, 'channel.from');
    var entry = _map[visitorId];
    if(data.message.length === 0 || data.message === '') {
        return;
    }
    var message_tone = _.get(data, 'context.dialog_tone');
    if(message_tone && message_tone.length> 0){
        var angry = _.filter(message_tone, {tone_name: 'angry'});
        if(angry.length){
            angry = angry[0];
            if(angry.level >=2){
                connectToAgent(requestId, data);
            }
            else {
                sdk.sendUserMessage(data, cb);
            }
        }
        else {
            sdk.sendUserMessage(data, cb);
        }
    }
    else if(!entry)
    {
        sdk.sendUserMessage(data, cb);
    }else if(data.message === "skipUserMessage"){ // condition for skipping a user message
	sdk.skipUserMessage(data, cb);
    }
}

/*
 * OnUserMessage event handler
 */
function onUserMessage(requestId, data, cb){
    debug("user message", data);
    var visitorId = _.get(data, 'channel.from');
    var entry = _map[visitorId];
    if(data.message == 'history'){
        getChathistory(data)
        data.message="Processing...chat history";
        return sdk.sendUserMessage(data, cb);
    }
    if(entry){//check for live agent
        //route to live agent
        var formdata = {};
        formdata.secured_session_id = entry.secured_session_id;
        formdata.licence_id = config.liveagentlicense;
        formdata.message = data.message;


        return api.sendMsg(visitorId, formdata)
            .catch(function(e){
                console.error(e);
                delete userDataMap[visitorId];
                delete _map[visitorId];
                return sdk.sendBotMessage(data, cb);
            });
    }
    else {
	if(data.message === "skipBotMessage") // condition for skipping a bot message
            return sdk.skipBotMessage(data, cb);
        else    
            return sdk.sendBotMessage(data, cb);
    }
}

/*
 * OnAgentTransfer event handler
 */
function onAgentTransfer(requestId, data, callback){
    connectToAgent(requestId, data, callback);
}

module.exports = {
    botId : botId,
    botName : botName,
    on_user_message : function(requestId, data, callback) {
        debug('on_user_message');
        onUserMessage(requestId, data, callback);
    },
    on_bot_message : function(requestId, data, callback) {
        debug('on_bot_message');
        onBotMessage(requestId, data, callback);
    },
    on_agent_transfer : function(requestId, data, callback) {
        debug('on_webhook');
        onAgentTransfer(requestId, data, callback);
    },
    on_event: function(requestId, data, callback) {
            // fetchAllBotVariables(data);
            return callback(null, data);
        },
    on_alert: function(requestId, data, callback) {
            // fetchAllBotVariables(data);
            return sdk.sendAlertMessage(data, callback);
        },
        on_variable_update: function(requestId, data, callback) {
            var event = data.eventType;
            // if (first || event == "bot_import" || event == "variable_import" || event == "sdk_subscription" || event == "language_enabled") {
            //     sdk.fetchBotVariable(data, langArr, function(err, response) {
            //         dataStore.saveAllVariables(response, langArr);
            //         first = false;
            //     });
            // } else {
            //     var lang = data.language;
            //     //update Exixting BotVariables in Storage
            //     updateBotVariableInDataStore(botVariables, data, event, lang);
            // }
            // console.log(dataStore);
    
        },
    gethistory: gethistory
};
function fetchAllBotVariables(data) {
        sdk.fetchBotVariable(data, langArr, function(err, response) {
            first = false;
            dataStore.saveAllVariables(response, langArr);
        });

}

function updateBotVariableInDataStore(botVariables, data, event, lang) {
    var variable = data.variable;
    if (event === "variable_create") {
        //update storage with newly created variable
        for (var i = 0; i < langArr.length; i++) {
            dataStore.addVariable(variable, i);
        }
    } else if (event == "variable_update") {
        //update storage with updated variable
        var index = langArr.indexOf(lang);
        if (index > -1) {
            dataStore.updateVariable(variable, langArr, index);
        }
    } else if (event == "variable_delete") {
        //delete variable from storage
        dataStore.deleteVariable(variable, langArr);
    }
}

function getChathistory(requestData){  
    if(requestData) {        
        var limit  = requestData.limit || 20;
        var offset = requestData.skip || 0;
        var userId = requestData.channel.handle.userId;
        var botId = requestData.botId;        
        var url    = `https://bots.kore.ai/api/public/bot/${botId}/getMessages?&userId=${userId}`;
        var headers;
        if (!headers) {
            headers = {};   
        }
        headers['content-type'] = 'application/json';
        headers.auth = getSignedJWTToken(botId);
        const body   = {}
        return makeHttpCall('get',url,body,headers)
        .then(function(res){    
		const historyData = res.data.messages.map(obj => ({
		type: obj.type === "outgoing" ? "bot" : "user",
		text: obj.components[0]?.data?.text || "No text found"
		}));
		console.log("historyData",historyData);
            return historyData;
        }).catch(function(err){
            console.log(err);        
        }); 
    }
}

function getSignedJWTToken(botId) {
    var appId, apiKey, jwtAlgorithm, jwtExpiry;
    var defAlg = "HS256";

    if (config.credentials[botId]) {
        appId = config.credentials[botId].appId;
        apiKey = config.credentials[botId].apikey;
    } else {
        appId = config.credentials.appId;
        apiKey = config.credentials.apikey;
    }

    if (config.jwt[botId]) {
        jwtAlgorithm = config.jwt[botId].jwtAlgorithm;
        jwtExpiry = config.jwt[botId].jwtExpiry;
    } else {
        jwtAlgorithm = config.jwt.jwtAlgorithm;
        jwtExpiry = config.jwt.jwtExpiry;
    }

    return jwt.encode({ 
        appId: appId, 
        exp: Date.now()/1000 + (jwtExpiry || 60) //set the default expiry as 60 seconds
    }, apiKey, (jwtAlgorithm || defAlg));
}
