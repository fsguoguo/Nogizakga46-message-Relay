/**
 * Bearer Token 认证中间件
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header'
    });
  }

  const token = authHeader.substring(7);

  // 验证 token（这里使用简单的环境变量比对，生产环境应使用 JWT）
  if (token !== process.env.ACCESS_TOKEN) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid access token'
    });
  }

  // 可以在这里从 token 中解析用户信息并设置到 req.user
  // req.user = { id: 'user_id', ... };

  next();
}

/**
 * 可选认证中间件（不强制要求 token）
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    if (token === process.env.ACCESS_TOKEN) {
      // Token 有效，设置用户信息
      // req.user = { id: 'user_id', ... };
    }
  }

  next();
}

/**
 * 错误处理中间件
 */
export function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  // 处理特定错误类型
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      message: err.message,
      details: err.details,
    });
  }

  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: err.message,
    });
  }

  // 默认 500 错误
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : err.message,
  });
}

/**
 * 404 处理中间件
 */
export function notFound(req, res) {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
  });
}

/**
 * 请求日志中间件
 */
export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `${req.method} ${req.path} ${res.statusCode} - ${duration}ms`
    );
  });

  next();
}
