/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
  * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tests the Dropbox Bigfile backend.
 */

const Cr = Components.results;
const MODULE_NAME = 'test-cloudfile-backend-dropbox';

const RELATIVE_ROOT = '../shared-modules';
const MODULE_REQUIRES = ['folder-display-helpers',
                         'compose-helpers',
                         'observer-helpers',];

const kDefaultServerPort = 4444;
const kServerRoot = "http://localhost:" + kDefaultServerPort;
const kServerPath = "/server/";
const kContentPath = "/content/";
const kAuthPath = "/auth/";
const kServerURL = kServerRoot + kServerPath;
const kContentURL = kServerRoot + kContentPath;
const kAuthURL = kServerRoot + kAuthPath;
const kOAuthTokenPath = "oauth/request_token";
const kOAuthAuthorizePath = "oauth/authorize";
const kOAuthAccessTokenPath = "oauth/access_token";
const kUserInfoPath = "account/info";
const kPutFilePath = "files_put/sandbox/";
const kSharesPath = "shares/sandbox/";
const kDeletePath = "fileops/delete/";
const kLogoutPath = "/logout";
const kLogoutURL = kServerRoot + kLogoutPath;

const kDefaultConfig = {
  port: kDefaultServerPort
}

const kAuthTokenString = "oauth_token=requestkey&oauth_token_secret=requestsecret";

const kDefaultUser = {
  referral_link: "https://www.dropbox.com/referrals/r1a2n3d4m5s6t7",
  display_name: "John P. User",
  uid: 12345678,
  country: "US",
  quota_info: {
    shared: 253738410565,
    quota: 107374182400000,
    normal: 680031877871
  },
  email: "john@example.com"
}

const kDefaultFilePutReturn = {
  size: "225.4KB",
  rev: "35e97029684fe",
  thumb_exists: false,
  bytes: 230783,
  modified: "Tue, 19 Jul 2011 21:55:38 +0000",
//  path: "/Getting_Started.pdf",
  is_dir: false,
  icon: "page_white_acrobat",
  root: "dropbox",
  mime_type: "application/pdf",
  revision: 220823
}

const kDefaultShareReturn = {
  url: "http://db.tt/APqhX1",
  expires: "Wed, 17 Aug 2011 02:34:33 +0000"
}

const kDefaultReturnHeader = {
  statusCode: 200,
  statusString: "OK",
  contentType: "text/plain",
}

const kDefaultDeleteReturn = {
  size: "0 bytes",
  is_deleted: true,
  bytes: 0,
  thumb_exists: false,
  rev: "1f33043551f",
  modified: "Wed, 10 Aug 2011 18:21:30 +0000",
//  path: "/test .txt",
  is_dir: false,
  icon: "page_white_text",
  root: "dropbox",
  mime_type: "text/plain",
  revision: 492341,
}

Cu.import('resource://gre/modules/Services.jsm');

let httpd = {};
Cu.import('resource://mozmill/stdlib/httpd.js', httpd);
Cu.import('resource://gre/modules/Services.jsm');

var gServer, gObsManager;

function setupModule(module) {
  let fdh = collector.getModule('folder-display-helpers');
  fdh.installInto(module);

  let ch = collector.getModule('compose-helpers');
  ch.installInto(module);

  let cfh = collector.getModule('cloudfile-helpers');
  cfh.installInto(module);

  let cbh = collector.getModule('cloudfile-backend-helpers');
  cbh.installInto(module);

  let oh = collector.getModule('observer-helpers');
  oh.installInto(module);

  gObsManager = new cbh.SimpleRequestObserverManager();

  // Enable logging for this test.
  Services.prefs.setCharPref("Dropbox.logging.dump", "All");
  Services.prefs.setCharPref("TBOAuth.logging.dump", "All");
};

function teardownModule() {
  Services.prefs.QueryInterface(Ci.nsIPrefBranch)
          .deleteBranch("mail.cloud_files.accounts");
  Services.prefs.clearUserPref("Dropbox.logging.dump");
  Services.prefs.clearUserPref("TBOAuth.logging.dump");
}

function setupTest() {
  gServer = new MockDropboxServer();
  gServer.init();
  gServer.start();
}

function teardownTest() {
  gObsManager.check();
  gObsManager.reset();
  gServer.stop(mc);
}

function MockDropboxServer() {}

MockDropboxServer.prototype = {
  _server: null,
  _toDelete: [],
  _timers: [],

  getPreparedBackend: function MDBS_getPreparedBackend(aAccountKey) {
    let dropbox = Cc["@mozilla.org/mail/dropbox;1"]
                  .createInstance(Ci.nsIMsgCloudFileProvider);

    let urls = [kServerURL, kContentURL, kAuthURL, kLogoutURL];
    dropbox.overrideUrls(urls.length, urls);
    dropbox.init(aAccountKey);
    return dropbox;
  },

  init: function MDBS_init(aConfig) {
    this._config = kDefaultConfig;

    for (let param in aConfig) {
      this._config[param] = aConfig[param];
    }

    this._server = httpd.getServer(this._config.port, '');
    this._wireOAuth();
    this._wireDeleter();
  },

  start: function MDBS_start() {
    this._server.start(this._config.port);
  },

  stop: function MDBS_stop(aController) {
    let allDone = false;
    this._server.stop(function() {
      allDone = true;
    });
    aController.waitFor(function () allDone,
                        "Timed out waiting for Dropbox server to stop!",
                        10000);
  },

  setupUser: function MDBS_wireUser(aData) {
    aData = this._overrideDefault(kDefaultUser, aData);

    let userFunc = this._noteAndReturnString("cloudfile:user", "",
                                             JSON.stringify(aData));

    this._server.registerPathHandler(kServerPath + kUserInfoPath,
                                     userFunc);
  },

  /**
   * Plan to upload a file with a particular filename.
   *
   * @param aFilename the name of the file that will be uploaded.
   * @param aMSeconds an optional argument, for how long the upload should
   *                  last in milliseconds.
   */
  planForUploadFile: function MDBS_planForUploadFile(aFilename, aMSeconds) {
    let data = kDefaultFilePutReturn;
    data.path = aFilename;

    // Prepare the function that will receive the upload and respond
    // appropriately.
    let putFileFunc = this._noteAndReturnString("cloudfile:uploadFile",
                                                aFilename,
                                                JSON.stringify(data));

    // Also prepare a function that will, if necessary, wait aMSeconds before
    // firing putFileFunc.
    let waitWrapperFunc = function(aRequest, aResponse) {
      Services.obs.notifyObservers(null, "cloudfile:uploadStarted",
                                   aFilename);

      if (!aMSeconds) {
        putFileFunc(aRequest, aResponse);
        return;
      }

      // Ok, we're waiting a bit.  Tell the HTTP server that we're going to
      // generate a response asynchronously, then set a timer to send the
      // response after aMSeconds milliseconds.
      aResponse.processAsync();
      let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      let timerEvent = {
        notify: function(aTimer) {
          putFileFunc(aRequest, aResponse);
          aResponse.finish();
        },
      };
      timer.initWithCallback(timerEvent, aMSeconds,
                             Ci.nsITimer.TYPE_ONE_SHOT);
      // We can't let the timer get garbage collected, so we store it.
      this._timers.push(timer);
    }.bind(this);

    this._server.registerPathHandler(kContentPath + kPutFilePath + aFilename,
                                     waitWrapperFunc);
  },

  planForGetFileURL: function MDBS_planForGetShare(aFileName, aData) {
    aData = this._overrideDefault(kDefaultShareReturn, aData);

    let getShareFunc = this._noteAndReturnString("cloudfile:getFileURL",
                                                 aFileName,
                                                 JSON.stringify(aData));
    this._server.registerPathHandler(kServerPath + kSharesPath + aFileName,
                                     getShareFunc);
  },

  planForDeleteFile: function MDBS_planForDeleteFile(aFilename) {
    this._toDelete.push(aFilename);
  },

  _wireDeleter: function MDBS__wireDeleter() {
    this._server.registerPathHandler(kServerPath + kDeletePath,
                                     this._delete.bind(this));
  },

  _delete: function MDBS__delete(aRequest, aResponse) {
    // Extract the query params
    let params = parseQueryString(aRequest.queryString);
    let pathIndex = this._toDelete.indexOf(params.path);

    if (pathIndex == -1) {
      aResponse.setStatusLine(null, 500, "Bad request");
      aResponse.write("Was not prepared to delete a file at path: "
                      + params.path);
      return;
    }

    this._toDelete.splice(pathIndex, 1);

    Services.obs.notifyObservers(null, "cloudfile:deleteFile",
                                 params.path);

    let data = kDefaultDeleteReturn;
    data.path = params.path;

    aResponse.setStatusLine(null, 200, "OK");
    aResponse.setHeader("Content-Type", "text/plain");
    aResponse.write(JSON.stringify(data));
  },

  _noteAndReturnString: function MDBS__noteAndReturnString(aKey, aValue,
                                                           aString,
                                                           aOptions) {

    aOptions = this._overrideDefault(kDefaultReturnHeader, aOptions);
    let self = this;

    let subjectString = Cc["@mozilla.org/supports-string;1"]
                        .createInstance(Ci.nsISupportsString);
    subjectString.data = aString;

    let func = function(aMeta, aResponse) {
      try {
        aResponse.setStatusLine(null, aOptions.statusCode,
                                aOptions.statusString);
        aResponse.setHeader("Content-Type", aOptions.contentType);
        aResponse.write(aString);
        Services.obs.notifyObservers(subjectString, aKey, aValue);
      } catch(e) {
        dump("Failed to generate server response: " + e);
      }
    }
    return func;
  },

  _overrideDefault: function MDBS__overrideDefault(aDefault, aData) {
    if (aData === undefined)
      return aDefault;

    for (let param in aDefault) {
      if (param in aData)
        aDefault[param] = aData[param];
    }
    return aDefault;
  },

  _wireOAuth: function MDBS__wireOAuth() {
    let authFunc = this._noteAndReturnString("cloudfile:auth", "",
                                             kAuthTokenString);

    this._server.registerPathHandler(kServerPath + kOAuthTokenPath,
                                     authFunc);
    this._server.registerPathHandler(kServerPath + kOAuthAccessTokenPath,
                                     authFunc);
    this._server.registerPathHandler(kAuthPath + kOAuthAuthorizePath,
                                     this._authHandler);

    let logoutFunc = this._noteAndReturnString("cloudfile:logout", "",
                                               "Successfully logged out!");
    this._server.registerPathHandler(kLogoutPath, logoutFunc);
  },

  _authHandler: function MDBS__authHandler(meta, response) {
    response.setStatusLine(null, 302, "Found");
    response.setHeader("Location", "http://oauthcallback.local/",
                       false);
  },
}

function parseQueryString(str)
{
  let paramArray = str.split("&");
  let regex = /^([^=]+)=(.*)$/;
  let params = {};
  for (let i = 0; i < paramArray.length; i++)
  {
    let match = regex.exec(paramArray[i]);
    if (!match)
      throw "Bad parameter in queryString!  '" + paramArray[i] + "'";
    params[decodeURIComponent(match[1])] = decodeURIComponent(match[2]);
  }

  return params;
}

function test_simple_case() {
  const kExpectedUrl = "http://www.example.com/expectedUrl";
  const kTopics = [kUploadFile, kGetFileURL];

  gServer.setupUser();
  gServer.planForUploadFile("testFile1");
  gServer.planForGetFileURL("testFile1", {url: kExpectedUrl});

  let obs = new ObservationRecorder();
  for each (let [, topic] in Iterator(kTopics)) {
    obs.planFor(topic);
    Services.obs.addObserver(obs, topic, false);
  }

  let requestObserver = gObsManager.create("test_simple_case - Upload 1");
  let file = getFile("./data/testFile1", __file__);
  let provider = gServer.getPreparedBackend("someAccountKey");
  provider.uploadFile(file, requestObserver);

  mc.waitFor(function () requestObserver.success);

  let urlForFile = provider.urlForFile(file);
  assert_equals(kExpectedUrl, urlForFile);
  assert_equals(1, obs.numSightings(kUploadFile));
  assert_equals(1, obs.numSightings(kGetFileURL));

  gServer.planForUploadFile("testFile1");
  gServer.planForGetFileURL("testFile1", {url: kExpectedUrl});
  requestObserver = gObsManager.create("test_simple_case - Upload 2");
  provider.uploadFile(file, requestObserver);
  mc.waitFor(function () requestObserver.success);
  urlForFile = provider.urlForFile(file);
  assert_equals(kExpectedUrl, urlForFile);

  assert_equals(2, obs.numSightings(kUploadFile));
  assert_equals(2, obs.numSightings(kGetFileURL));

  for each (let [, topic] in Iterator(kTopics)) {
    Services.obs.removeObserver(obs, topic);
  }
}

function test_chained_uploads() {
  const kExpectedUrlRoot = "http://www.example.com/";
  const kTopics = [kUploadFile, kGetFileURL];
  const kFilenames = ["testFile1", "testFile2", "testFile3"];

  gServer.setupUser();

  for each (let [, filename] in Iterator(kFilenames)) {
    let expectedUrl = kExpectedUrlRoot + filename;
    gServer.planForUploadFile(filename);
    gServer.planForGetFileURL(filename, {url: expectedUrl});
  }

  let obs = new ObservationRecorder();
  for each (let [, topic] in Iterator(kTopics)) {
    obs.planFor(topic);
    Services.obs.addObserver(obs, topic, false);
  }

  let provider = gServer.getPreparedBackend("someAccountKey");

  let files = [];

  let observers = kFilenames.map(function(aFilename) {
    let requestObserver = gObsManager.create("test_chained_uploads for filename " + aFilename);
    let file = getFile("./data/" + aFilename, __file__);
    files.push(file);
    provider.uploadFile(file, requestObserver);
    return requestObserver;
  });

  mc.waitFor(function() {
    return observers.every(function(aListener) aListener.success);
  }, "Timed out waiting for chained uploads to complete.");

  assert_equals(kFilenames.length, obs.numSightings(kUploadFile));

  for (let [index, filename] in Iterator(kFilenames)) {
    assert_equals(obs.data[kUploadFile][index], filename);
    let file = getFile("./data/" + filename, __file__);
    let expectedUriForFile = kExpectedUrlRoot + filename;
    let uriForFile = provider.urlForFile(files[index]);
    assert_equals(expectedUriForFile, uriForFile);
  }

  assert_equals(kFilenames.length, obs.numSightings(kGetFileURL));

  for each (let [, topic] in Iterator(kTopics)) {
    Services.obs.removeObserver(obs, topic);
  }
}

function test_deleting_uploads() {
  const kFilename = "testFile1";
  gServer.setupUser();
  let provider = gServer.getPreparedBackend("someAccountKey");
  // Upload a file

  let file = getFile("./data/" + kFilename, __file__);
  gServer.planForUploadFile(kFilename);
  gServer.planForGetFileURL(kFilename,
                                {url: "http://www.example.com/someFile"});
  let requestObserver = gObsManager.create("test_deleting_uploads - upload 1");
  provider.uploadFile(file, requestObserver);
  mc.waitFor(function() requestObserver.success);

  // Try deleting a file
  let obs = new ObservationRecorder();
  obs.planFor(kDeleteFile);
  Services.obs.addObserver(obs, kDeleteFile, false);

  gServer.planForDeleteFile(kFilename);
  let deleteObserver = gObsManager.create("test_deleting_uploads - delete 1");
  provider.deleteFile(file, deleteObserver);
  mc.waitFor(function() deleteObserver.success);

  // Check to make sure the file was deleted on the server
  assert_equals(1, obs.numSightings(kDeleteFile));
  assert_equals(obs.data[kDeleteFile][0], kFilename);
  Services.obs.removeObserver(obs, kDeleteFile);
}

/**
 * Test that when we call createExistingAccount, onStopRequest is successfully
 * called, and we pass the correct parameters.
 */
function test_create_existing_account() {
  let provider = gServer.getPreparedBackend("someNewAccount");
  let done = false;
  let myObs = {
    onStartRequest: function(aRequest, aContext) {
    },
    onStopRequest: function(aRequest, aContext, aStatusCode) {
      assert_true(aContext instanceof Ci.nsIMsgCloudFileProvider);
      assert_equals(aStatusCode, Components.results.NS_OK);
      done = true;
    },
  }

  provider.createExistingAccount(myObs);
  mc.waitFor(function() done);
}

/**
 * Test that cancelling an upload causes onStopRequest to be
 * called with nsIMsgCloudFileProvider.uploadCanceled.
 */
function test_can_cancel_upload() {
  const kFilename = "testFile1";
  gServer.setupUser();
  let provider = gServer.getPreparedBackend("someNewAccount");
  let file = getFile("./data/" + kFilename, __file__);
  gServer.planForUploadFile(kFilename, 2000);
  assert_can_cancel_uploads(mc, provider, [file]);
}

/**
 * Test that cancelling several uploads causes onStopRequest to be
 * called with nsIMsgCloudFileProvider.uploadCanceled.
 */
function test_can_cancel_uploads() {
  const kFiles = ["testFile2", "testFile3", "testFile4"];
  gServer.setupUser();
  let provider = gServer.getPreparedBackend("someNewAccount");
  let files = [];
  for each (let [, filename] in Iterator(kFiles)) {
    gServer.planForUploadFile(filename, 2000);
    files.push(getFile("./data/" + filename, __file__));
  }
  assert_can_cancel_uploads(mc, provider, files);
}

/**
 * Test that completing the OAuth procedure results in an attempt to logout.
 */
function test_oauth_complete_causes_logout() {
  let provider = gServer.getPreparedBackend("someNewAccount");
  let dummyObs = gObsManager.create("test_oauth_complete_causes_logout");
  let obs = new ObservationRecorder();
  obs.planFor(kLogout);
  Services.obs.addObserver(obs, kLogout, false);
  provider.createExistingAccount(dummyObs);
  mc.waitFor(function() dummyObs.success);
  mc.waitFor(function() 1 == obs.numSightings(kLogout));
  Services.obs.removeObserver(obs, kLogout);
}

/**
 * Test that we calculate the used and remaining storage amounts correctly.
 */
function test_calculate_used_and_remaining_storage_correctly() {
  const kShared = 12345;
  const kNormal = 67890;
  const kQuota = 31415926535;

  let provider = gServer.getPreparedBackend("someNewAccount");

  // Override the returned user profile values with the ones we defined
  // above.
  gServer.setupUser({
    quota_info: {
      shared: kShared,
      quota: kQuota,
      normal: kNormal,
    }
  });

  let gotUserInfo = false;
  let statusCode = null;

  // Make the provider get the user profile from the fake server.
  provider.refreshUserInfo(false, {
    onStartRequest: function(aRequest, aContext) {},
    onStopRequest: function(aRequest, aContext, aStatusCode) {
      gotUserInfo = true;
      statusCode = aStatusCode;
    },
  });

  // These are the correct calculations that we should get back.
  const kUsedSpace = kShared + kNormal;
  const kRemainingSpace = kQuota - kUsedSpace;

  mc.waitFor(function() gotUserInfo);
  assert_equals(statusCode, Cr.NS_OK);
  assert_equals(provider.fileSpaceUsed, kUsedSpace);
  assert_equals(provider.remainingFileSpace, kRemainingSpace);
}
