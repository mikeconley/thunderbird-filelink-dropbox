How to run these tests:

* Create a build of Thunderbird. The build directory will be referred to as the "objdir".
* Create a symlink at mail/test/mozmill/cloudfile/test-cloudfile-backend-dropbox.js pointing to the test in this directory. (Symlinking isn't the greatest, but it's what works.)
* Build the Dropbox Filelink add-on, and then execute the tests by navigating to the Thunderbird objdir, and running:

make MOZMILL_EXTRA="--addons=[PATH TO thunderbird-filelink-dropbox.xpi]" SOLO_TEST=cloudfile/test-cloudfile-backend-dropbox.js mozmill-one

That *should* run the tests.
