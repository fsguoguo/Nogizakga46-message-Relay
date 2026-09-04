import express from 'express';
import deviceService from '../services/device.js';

const router = express.Router();

/**
 * POST /v1/devices
 * 注册设备
 */
router.post('/', async (req, res) => {
  try {
    const { token, platform, label } = req.body;

    if (!token || !platform) {
      return res.status(400).json({
        error: 'Missing required fields: token, platform'
      });
    }

    if (!['android', 'ios'].includes(platform)) {
      return res.status(400).json({
        error: 'Invalid platform, must be android or ios'
      });
    }

    const userId = req.user?.id || null; // 如果有用户认证系统

    const result = await deviceService.registerDevice({
      fcmToken: token,
      platform,
      label: label || 'Unknown Device',
      userId,
    });

    res.status(result.isNew ? 201 : 200).json({
      success: true,
      device: {
        id: result.device.id,
        platform: result.device.platform,
        label: result.device.label,
        created_at: result.device.created_at,
      },
      isNew: result.isNew,
    });
  } catch (error) {
    console.error('Register device error:', error);
    res.status(500).json({
      error: 'Failed to register device',
      message: error.message,
    });
  }
});

/**
 * GET /v1/devices
 * 获取所有设备
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id || null;
    const devices = await deviceService.getAllDevices(userId);

    res.json({
      success: true,
      devices: devices.map(d => ({
        id: d.id,
        platform: d.platform,
        label: d.label,
        last_seen_at: d.last_seen_at,
        created_at: d.created_at,
      })),
    });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({
      error: 'Failed to get devices',
      message: error.message,
    });
  }
});

/**
 * DELETE /v1/devices/:id
 * 删除设备
 */
router.delete('/:id', async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id, 10);

    if (isNaN(deviceId)) {
      return res.status(400).json({
        error: 'Invalid device ID'
      });
    }

    const deleted = await deviceService.deleteDevice(deviceId);

    if (!deleted) {
      return res.status(404).json({
        error: 'Device not found'
      });
    }

    res.json({
      success: true,
      message: 'Device deleted successfully'
    });
  } catch (error) {
    console.error('Delete device error:', error);
    res.status(500).json({
      error: 'Failed to delete device',
      message: error.message,
    });
  }
});

export default router;
