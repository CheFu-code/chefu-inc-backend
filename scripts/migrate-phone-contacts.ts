import 'reflect-metadata';
import { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';
import { migratePhoneContacts } from './phone-contact-migration';

// Dry run by default. Never log phone numbers, emails, OTPs or credentials.
void migratePhoneContacts(new FirebaseAdminService(), process.argv.includes('--apply'))
  .then(result => console.log(JSON.stringify(result)))
  .catch(() => {
    console.error('Phone contact migration failed. Check database access and retry; no customer data was logged.');
    process.exitCode = 1;
  });
