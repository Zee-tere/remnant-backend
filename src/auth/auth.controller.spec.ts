import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GuestAccessService } from './guest-access.service';

describe('AuthController', () => {
  let controller: AuthController;
  const authService = { logout: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: authService,
        },
        { provide: GuestAccessService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('clears the refresh cookie without a future max-age', async () => {
    authService.logout.mockResolvedValueOnce({ success: true });
    const response = { clearCookie: jest.fn() };

    await controller.logout(
      {},
      { headers: { cookie: 'remnant_refresh=secret' } } as never,
      response as never,
    );

    expect(response.clearCookie).toHaveBeenCalledWith(
      'remnant_refresh',
      expect.not.objectContaining({ maxAge: expect.anything() }),
    );
    expect(authService.logout).toHaveBeenCalledWith(undefined, 'secret');
  });
});
