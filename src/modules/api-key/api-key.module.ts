import { Module } from '@nestjs/common';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { ApiKeyService } from './api-key.service';

@Module({
    imports: [FirebaseAdminModule],
    providers: [ApiKeyService],
    exports: [ApiKeyService],
})
export class ApiKeyModule { }
