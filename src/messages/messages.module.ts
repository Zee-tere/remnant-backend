import { Module } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [AuthModule, NotificationsModule, UploadModule],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
