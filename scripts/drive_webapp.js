// StoryPilot - Drive Sync Web App (one-time setup, ~3 minutes)
// =============================================================
// This tiny script turns your Google Drive into an upload target for the
// Continuous Video Factory. It runs on YOUR Google account (the same one that
// owns the Spark sheet) - no OAuth clients, no service accounts, no API keys.
//
// SETUP (once):
//   1. Open https://script.google.com  ->  New project
//   2. Delete everything in Code.gs and paste this whole file.
//   3. (Optional but recommended) change the KEY below to a long random string
//      (e.g. from https://www.random.org/strings). You will paste the same
//      string into the GitHub secret DRIVE_WEBAPP_KEY.
//   4. Deploy  ->  New deployment
//      - Select the gear icon  ->  Web app
//      - Description: StoryPilot Drive Sync
//      - Execute as:        Me (your@gmail.com)
//      - Who has access:    Anyone            <-- required, GitHub calls this
//      - Deploy  ->  Authorize (Drive scope)  -> copy the /exec URL
//   5. Put the URL in your repo:
//      StoryPilot app -> Platforms -> Google Drive -> paste -> Save
//      (it is stored encrypted in the repo secret DRIVE_WEBAPP_URL)
//
// After that, every finished video appears in Drive under
// "StoryPilot Videos / 2026-10-07 <title> [<id>] /" within an hour,
// and the factory keeps them coming.

var KEY = '';                    // optional shared secret (also in DRIVE_WEBAPP_KEY secret)
var ROOT = 'StoryPilot Videos';  // matches DRIVE_ROOT_FOLDER (repo variable)

function doGet(e) {
  if (KEY && e.parameter.key !== KEY) return _json({ ok: false, error: 'bad key' });
  return _json({ ok: true, root: ROOT, time: new Date().toISOString() });
}

function doPost(e) {
  try {
    if (KEY && e.parameter.key !== KEY) return _json({ ok: false, error: 'bad key' });
    var name = (e.parameter.filename || 'unnamed').replace(/[\\/:*?"<>|]/g, '_');
    var folderPath = String(e.parameter.folder || '').split('/').map(function (s) {
      return s.replace(/[\\/:*?"<>|]/g, '_').trim();
    }).filter(String);
    var mime = e.parameter.mime || 'application/octet-stream';
    if (e.parameter.b64 === '1') {
      var bytes = Utilities.base64Decode(e.postData.contents);
      var blob = Utilities.newBlob(bytes, mime, name);
      var file = _folder(folderPath).createFile(blob);
      return _json({ ok: true, fileId: file.getId(), name: name, url: file.getUrl(),
                     folder: folderPath.join('/') });
    }
    return _json({ ok: false, error: 'expected b64=1' });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function _folder(path) {
  var root = DriveApp.getRootFolder();
  var it = root.getFoldersByName(ROOT);
  var f = it.hasNext() ? it.next() : root.createFolder(ROOT);
  for (var i = 0; i < path.length; i++) {
    var kids = f.getFoldersByName(path[i]);
    f = kids.hasNext() ? kids.next() : f.createFolder(path[i]);
  }
  return f;
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
