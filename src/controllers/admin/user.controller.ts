import { Request, Response } from "express";
import User from "../../models/Users";
import Booking from "../../models/booking.model";
import Wallet from "../../models/wallet.model";
import { CoinWallet, CoinTransaction } from "../../models/coin.model";
import UserAddress from "../../models/UserAddress";
import WalletTransaction from "../../models/wallet-transaction.model";
import { createAuditEntry } from "./audit-log.controller";

// Pull the acting admin's identity off the request (set by admin-auth middleware).
const actingAdmin = (req: Request) => {
  const a = (req as any).admin || {};
  return {
    adminId: (req as any).adminId || String(a._id || ""),
    adminName: a.name || a.fullName || "Admin",
    adminEmail: a.email || "",
    adminRole: a.roleName || a.role,
  };
};

/**
 * Get all users with filters
 */
export const getAllUsers = async (req: Request, res: Response) => {
  const {
    status,
    search,
    dateFrom,
    dateTo,
    page = 0,
    limit = 20,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = req.query;

  const parsedPage = Math.max(Number(page), 0);
  const parsedLimit = Math.min(Math.max(Number(limit), 1), 100);

  // Support deleted filter
  const query: Record<string, unknown> = {};
  if (status === "deleted") {
    query.isDeleted = true;
  } else {
    query.isDeleted = false;
  }

  if (status === "active") {
    query.isActive = true;
    query.isBlocked = false;
  }
  if (status === "inactive") {
    query.isActive = false;
    query.isBlocked = false;
  }
  if (status === "blocked") query.isBlocked = true;

  if (dateFrom || dateTo) {
    const createdAt: Record<string, Date> = {};
    if (dateFrom) createdAt.$gte = new Date(dateFrom as string);
    if (dateTo) createdAt.$lte = new Date(dateTo as string);
    query.createdAt = createdAt;
  }

  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: "i" } },
      { mobileNumber: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { referralCode: { $regex: search, $options: "i" } },
      // The short display ID ("CUS-0042"), matched loosely so a bare number
      // works too.
      { userCode: { $regex: search, $options: "i" } },
    ];
  }

  const sortableFields: Record<string, string> = {
    createdAt: "createdAt",
    name: "fullName",
    status: "isActive",
  };

  const sortField = sortableFields[String(sortBy)] || "createdAt";
  const sortDirection = String(sortOrder).toLowerCase() === "asc" ? 1 : -1;

  const users = await User.find(query)
    .select("-__v")
    .sort({ [sortField]: sortDirection })
    .skip(parsedPage * parsedLimit)
    .limit(parsedLimit);

  const total = await User.countDocuments(query);

  const userIds = users.map((user) => user._id.toString());

  // Fetch addresses for all users
  const addresses = await UserAddress.find({
    userId: { $in: userIds },
    isActive: true,
  })
    .sort({ isSelected: -1, updatedAt: -1 })
    .lean();

  const addressMap = new Map<string, (typeof addresses)[number][]>();
  addresses.forEach((address) => {
    const key = address.userId.toString();
    if (!addressMap.has(key)) {
      addressMap.set(key, []);
    }
    addressMap.get(key)!.push(address);
  });

  // Fetch coin wallets for all users
  const coinWallets = await CoinWallet.find({
    userId: { $in: userIds },
  }).lean();

  const coinWalletMap = new Map<string, (typeof coinWallets)[number]>();
  coinWallets.forEach((wallet) => {
    coinWalletMap.set(wallet.userId.toString(), wallet);
  });

  // Fetch wallet balances for all users
  const wallets = await Wallet.find({
    userId: { $in: userIds },
  }).lean();

  const walletMap = new Map<string, (typeof wallets)[number]>();
  wallets.forEach((wallet) => {
    walletMap.set(wallet.userId.toString(), wallet);
  });

  const usersWithStats = await Promise.all(
    users.map(async (user) => {
      const bookingCount = await Booking.countDocuments({ userId: user._id });
      const completedCount = await Booking.countDocuments({
        userId: user._id,
        status: "COMPLETED",
      });
      // Only cancellations the CUSTOMER made count toward "risky" — a driver
      // or system cancellation is not this user's behaviour.
      const cancelledByUserCount = await Booking.countDocuments({
        userId: user._id,
        status: "CANCELLED",
        cancelledBy: "USER",
      });

      // Calculate total spent from completed bookings
      const spentAggregation = await Booking.aggregate([
        { $match: { userId: user._id, status: "COMPLETED" } },
        { $group: { _id: null, totalSpent: { $sum: "$finalFare" } } },
      ]);
      const totalSpent = spentAggregation[0]?.totalSpent ?? 0;

      const userAddresses = addressMap.get(user._id.toString()) || [];
      const primaryAddress =
        userAddresses.find((a) => a.isSelected) || userAddresses[0] || null;
      const coinWallet = coinWalletMap.get(user._id.toString());
      const wallet = walletMap.get(user._id.toString());

      return {
        ...user.toObject(),
        bookingCount,
        completedBookings: completedCount,
        cancelledByUserCount,
        totalSpent,
        coinBalance: coinWallet?.balance ?? 0,
        walletBalance: wallet?.balance ?? 0,
        addressCount: userAddresses.length,
        primaryAddress: primaryAddress
          ? {
              id: primaryAddress._id,
              address: primaryAddress.address,
              area: primaryAddress.area,
              city: primaryAddress.city,
              state: primaryAddress.state,
              country: primaryAddress.country,
              pinCode: primaryAddress.pinCode,
              latitude: primaryAddress.latitude,
              longitude: primaryAddress.longitude,
              addressType: primaryAddress.addressType,
            }
          : null,
        allAddresses: userAddresses.map((a) => ({
          id: a._id,
          addressType: a.addressType,
          houseNo: a.houseNo,
          area: a.area,
          address: a.address,
          city: a.city,
          state: a.state,
          country: a.country,
          pinCode: a.pinCode,
          latitude: a.latitude,
          longitude: a.longitude,
          isSelected: a.isSelected,
        })),
      };
    }),
  );

  if (sortBy === "bookings") {
    usersWithStats.sort((a, b) =>
      sortDirection === 1
        ? a.bookingCount - b.bookingCount
        : b.bookingCount - a.bookingCount,
    );
  }

  res.locals.data = {
    users: usersWithStats,
    total,
    page: parsedPage,
    limit: parsedLimit,
    totalPages: Math.ceil(total / parsedLimit),
  };
};

/**
 * Get user by ID
 */
export const getUserById = async (req: Request, res: Response) => {
  const { id } = req.params;

  const user = await User.findById(id);

  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  // Get additional data
  const [wallet, coinWallet, addresses, bookingStats] = await Promise.all([
    Wallet.findOne({ userId: id }),
    CoinWallet.findOne({ userId: id }),
    UserAddress.find({ userId: id, isActive: true }),
    Booking.aggregate([
      { $match: { userId: user._id } },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalSpent: { $sum: "$finalFare" },
        },
      },
    ]),
  ]);

  res.locals.data = {
    user,
    wallet: wallet || { balance: 0, lockedBalance: 0 },
    coinWallet: coinWallet || { balance: 0, totalEarned: 0, totalRedeemed: 0 },
    addresses,
    bookingStats,
  };
};

/**
 * Update user status
 */
export const updateUserStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { isActive, reason } = req.body;

  const before = await User.findById(id).select("isActive");
  if (!before) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const user = await User.findByIdAndUpdate(id, { isActive }, { new: true });

  // Record the status change in the audit log (was a TODO).
  await createAuditEntry({
    ...actingAdmin(req),
    action: "CHANGE_STATUS",
    module: "users",
    targetId: id,
    targetType: "User",
    description: `${isActive ? "Activated" : "Deactivated"} user ${user?.mobileNumber || id}${reason ? ` — ${reason}` : ""}`,
    changes: [{ field: "isActive", oldValue: before.isActive, newValue: isActive }],
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.locals.data = {
    message: `User ${isActive ? "activated" : "deactivated"} successfully`,
    user,
  };
};

/**
 * Update user profile information
 */
export const updateUser = async (req: Request, res: Response) => {
  const { id } = req.params;
  const allowedFields = [
    "fullName",
    "email",
    "gender",
    "dob",
    "notificationAllowed",
  ];

  const updatePayload: Record<string, unknown> = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      updatePayload[field] = req.body[field];
    }
  });

  const user = await User.findByIdAndUpdate(id, updatePayload, { new: true });

  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  res.locals.data = {
    message: "User profile updated",
    user,
  };
};

/**
 * Block a user
 */
export const blockUser = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body;

  const blockReason = reason?.trim() || "Blocked by admin";

  const before = await User.findById(id).select("isBlocked isActive");
  if (!before) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const user = await User.findByIdAndUpdate(
    id,
    {
      isBlocked: true,
      blockReason,
      blockedAt: new Date(),
      isActive: false,
    },
    { new: true },
  );

  // Record the block in the audit log.
  await createAuditEntry({
    ...actingAdmin(req),
    action: "BLOCK",
    module: "users",
    targetId: id,
    targetType: "User",
    description: `Blocked user ${user?.mobileNumber || id} — ${blockReason}`,
    changes: [
      { field: "isBlocked", oldValue: before.isBlocked, newValue: true },
      { field: "isActive", oldValue: before.isActive, newValue: false },
    ],
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.locals.data = {
    message: "User blocked successfully",
    user,
  };
};

/**
 * Unblock a user
 */
export const unblockUser = async (req: Request, res: Response) => {
  const { id } = req.params;

  const before = await User.findById(id).select("isBlocked isActive");
  if (!before) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const user = await User.findByIdAndUpdate(
    id,
    {
      isBlocked: false,
      blockReason: null,
      blockedAt: null,
      isActive: true,
    },
    { new: true },
  );

  // Record the unblock in the audit log.
  await createAuditEntry({
    ...actingAdmin(req),
    action: "UNBLOCK",
    module: "users",
    targetId: id,
    targetType: "User",
    description: `Unblocked user ${user?.mobileNumber || id}`,
    changes: [
      { field: "isBlocked", oldValue: before.isBlocked, newValue: false },
      { field: "isActive", oldValue: before.isActive, newValue: true },
    ],
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.locals.data = {
    message: "User unblocked successfully",
    user,
  };
};

/**
 * Soft delete a user
 */
export const deleteUser = async (req: Request, res: Response) => {
  const { id } = req.params;

  const before = await User.findById(id).select("isDeleted");
  if (!before) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const user = await User.findByIdAndUpdate(
    id,
    {
      isDeleted: true,
      isActive: false,
      isBlocked: false,
      blockReason: null,
      blockedAt: null,
    },
    { new: true },
  );

  // Record the (soft) delete in the audit log — CRITICAL impact.
  await createAuditEntry({
    ...actingAdmin(req),
    action: "DELETE",
    module: "users",
    targetId: id,
    targetType: "User",
    description: `Deleted user ${user?.mobileNumber || id}`,
    changes: [{ field: "isDeleted", oldValue: before.isDeleted, newValue: true }],
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.locals.data = {
    message: "User deleted successfully",
    user,
  };
};

/**
 * Restore a deleted user
 */
export const restoreUser = async (req: Request, res: Response) => {
  const { id } = req.params;

  const before = await User.findById(id).select("isDeleted");
  if (!before) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  const user = await User.findByIdAndUpdate(
    id,
    {
      isDeleted: false,
      isActive: true,
    },
    { new: true },
  );

  // Record the restore in the audit log.
  await createAuditEntry({
    ...actingAdmin(req),
    action: "UPDATE",
    module: "users",
    targetId: id,
    targetType: "User",
    description: `Restored user ${user?.mobileNumber || id}`,
    changes: [{ field: "isDeleted", oldValue: before.isDeleted, newValue: false }],
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.locals.data = {
    message: "User restored successfully",
    user,
  };
};

/**
 * Get user bookings
 */
export const getUserBookings = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, page = 0, limit = 20 } = req.query;

  const query: any = { userId: id };
  if (status) query.status = status;

  const bookings = await Booking.find(query)
    .populate("driverId", "fullName mobileNumber")
    .populate("vehicleTypeId", "name")
    .sort({ createdAt: -1 })
    .skip(Number(page) * Number(limit))
    .limit(Number(limit));

  const total = await Booking.countDocuments(query);

  res.locals.data = {
    bookings,
    total,
    page: Number(page),
    limit: Number(limit),
  };
};

/**
 * Get user wallet
 */
export const getUserWallet = async (req: Request, res: Response) => {
  const { id } = req.params;

  const wallet = await Wallet.findOne({ userId: id });
  const coinWallet = await CoinWallet.findOne({ userId: id });

  res.locals.data = {
    wallet: wallet || { balance: 0, lockedBalance: 0 },
    coinWallet: coinWallet || { balance: 0, totalEarned: 0, totalRedeemed: 0 },
  };
};

/**
 * Add balance to user wallet (Admin)
 */
export const addWalletBalance = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { amount, reason } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Valid amount is required",
    });
  }

  const balanceBefore =
    (await Wallet.findOne({ userId: id }).select("balance"))?.balance || 0;

  const wallet = await Wallet.findOneAndUpdate(
    { userId: id },
    { $inc: { balance: amount } },
    { new: true, upsert: true },
  );

  // Record the wallet transaction (was a TODO — the credit left no trail).
  await WalletTransaction.create({
    userId: id,
    type: "CREDIT",
    amount,
    balanceBefore,
    balanceAfter: wallet.balance,
    description: reason || "Admin credit",
    status: "COMPLETED",
  });

  await createAuditEntry({
    ...actingAdmin(req),
    action: "UPDATE",
    module: "users",
    targetId: id,
    targetType: "User",
    description: `Credited ₹${amount} to wallet${reason ? ` — ${reason}` : ""}`,
    changes: [{ field: "balance", oldValue: balanceBefore, newValue: wallet.balance }],
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.locals.data = {
    message: `₹${amount} added to wallet`,
    wallet,
  };
};

/**
 * Adjust user coin balance (Admin)
 */
export const adjustUserCoins = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { type, amount, reason } = req.body as {
    type?: "CREDIT" | "DEBIT";
    amount?: number;
    reason?: string;
  };

  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Valid amount is required",
    });
  }
  if (type !== "CREDIT" && type !== "DEBIT") {
    return res.status(400).json({
      success: false,
      message: "type must be CREDIT or DEBIT",
    });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({
      success: false,
      message: "Reason is required",
    });
  }

  const existing = await CoinWallet.findOne({ userId: id });
  if (type === "DEBIT") {
    const currentBalance = existing?.balance ?? 0;
    if (currentBalance < parsedAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient coin balance",
      });
    }
  }

  const delta = type === "CREDIT" ? parsedAmount : -parsedAmount;
  const earnedDelta = type === "CREDIT" ? parsedAmount : 0;
  const redeemedDelta = type === "DEBIT" ? parsedAmount : 0;

  const wallet = await CoinWallet.findOneAndUpdate(
    { userId: id },
    {
      $inc: {
        balance: delta,
        totalEarned: earnedDelta,
        totalRedeemed: redeemedDelta,
      },
    },
    { new: true, upsert: true },
  );

  await CoinTransaction.create({
    userId: id,
    amount: parsedAmount,
    type: type === "CREDIT" ? "EARNED" : "REDEEMED",
    source: "BONUS",
    description: reason,
    status: "COMPLETED",
  });

  res.locals.data = {
    message: `${type === "CREDIT" ? "Credited" : "Debited"} ${parsedAmount} coins`,
    wallet,
  };
};

/**
 * Get user stats summary
 */
export const getUserStats = async (req: Request, res: Response) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  const [
    totalUsers,
    activeUsers,
    blockedUsers,
    deletedUsers,
    newToday,
    newThisMonth,
    totalBookings,
    revenueAggregation,
  ] = await Promise.all([
    User.countDocuments({ isDeleted: false }),
    User.countDocuments({ isDeleted: false, isActive: true, isBlocked: false }),
    User.countDocuments({ isDeleted: false, isBlocked: true }),
    User.countDocuments({ isDeleted: true }),
    User.countDocuments({ createdAt: { $gte: today }, isDeleted: false }),
    User.countDocuments({ createdAt: { $gte: thisMonth }, isDeleted: false }),
    Booking.countDocuments({}),
    Booking.aggregate([
      { $match: { status: "COMPLETED" } },
      { $group: { _id: null, totalRevenue: { $sum: "$finalFare" } } },
    ]),
  ]);

  const totalRevenue = revenueAggregation[0]?.totalRevenue ?? 0;

  res.locals.data = {
    totalUsers,
    activeUsers,
    inactiveUsers: totalUsers - activeUsers - blockedUsers,
    blockedUsers,
    deletedUsers,
    newToday,
    newThisMonth,
    totalBookings,
    totalRevenue,
  };
};

/**
 * Get user transactions
 */
export const getUserTransactions = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { page = 0, limit = 20, type } = req.query;

  const query: Record<string, unknown> = { userId: id };
  if (type === "CREDIT" || type === "DEBIT") {
    query.type = type;
  }

  const transactions = await WalletTransaction.find(query)
    .sort({ createdAt: -1 })
    .skip(Number(page) * Number(limit))
    .limit(Number(limit));

  const total = await WalletTransaction.countDocuments(query);

  res.locals.data = {
    transactions,
    total,
    page: Number(page),
    limit: Number(limit),
  };
};

/**
 * Get user addresses
 */
export const getUserAddresses = async (req: Request, res: Response) => {
  const { id } = req.params;

  const addresses = await UserAddress.find({ userId: id, isActive: true }).sort(
    { isSelected: -1, updatedAt: -1 },
  );

  res.locals.data = { addresses };
};

/**
 * Add user address (Admin)
 */
export const addUserAddress = async (req: Request, res: Response) => {
  const { id } = req.params;
  const {
    fullName,
    mobileNumber,
    houseNo,
    area,
    city,
    state,
    country = "India",
    pinCode,
    addressType,
    latitude,
    longitude,
    isSelected,
  } = req.body;

  // Check user exists
  const user = await User.findById(id);
  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  // Build the address string
  const addressParts = [houseNo, area, city, state].filter(Boolean);
  const address = pinCode
    ? `${addressParts.join(", ")} - ${pinCode}`
    : addressParts.join(", ");

  // If isSelected, unselect others
  if (isSelected) {
    await UserAddress.updateMany(
      { userId: id, isActive: true },
      { isSelected: false },
    );
  }

  const newAddress = await UserAddress.create({
    userId: id,
    fullName: fullName || user.fullName,
    mobileNumber: mobileNumber || user.mobileNumber,
    houseNo,
    area,
    address,
    city,
    state,
    country,
    pinCode,
    addressType,
    latitude,
    longitude,
    isSelected: isSelected || false,
    isActive: true,
  });

  res.locals.data = {
    message: "Address added successfully",
    address: newAddress,
  };
};

/**
 * Update user address (Admin)
 */
export const updateUserAddress = async (req: Request, res: Response) => {
  const { id, addressId } = req.params;
  const {
    fullName,
    mobileNumber,
    houseNo,
    area,
    city,
    state,
    country,
    pinCode,
    addressType,
    latitude,
    longitude,
    isSelected,
  } = req.body;

  const address = await UserAddress.findOne({
    _id: addressId,
    userId: id,
    isActive: true,
  });

  if (!address) {
    return res.status(404).json({
      success: false,
      message: "Address not found",
    });
  }

  // Build the address string if components changed
  const newHouseNo = houseNo !== undefined ? houseNo : address.houseNo;
  const newArea = area !== undefined ? area : address.area;
  const newCity = city !== undefined ? city : address.city;
  const newState = state !== undefined ? state : address.state;
  const newPinCode = pinCode !== undefined ? pinCode : address.pinCode;

  const addressParts = [newHouseNo, newArea, newCity, newState].filter(Boolean);
  const addressString = newPinCode
    ? `${addressParts.join(", ")} - ${newPinCode}`
    : addressParts.join(", ");

  // If isSelected, unselect others
  if (isSelected === true) {
    await UserAddress.updateMany(
      { userId: id, isActive: true, _id: { $ne: addressId } },
      { isSelected: false },
    );
  }

  const updatedAddress = await UserAddress.findByIdAndUpdate(
    addressId,
    {
      ...(fullName !== undefined && { fullName }),
      ...(mobileNumber !== undefined && { mobileNumber }),
      ...(houseNo !== undefined && { houseNo }),
      ...(area !== undefined && { area }),
      address: addressString,
      ...(city !== undefined && { city }),
      ...(state !== undefined && { state }),
      ...(country !== undefined && { country }),
      ...(pinCode !== undefined && { pinCode }),
      ...(addressType !== undefined && { addressType }),
      ...(latitude !== undefined && { latitude }),
      ...(longitude !== undefined && { longitude }),
      ...(isSelected !== undefined && { isSelected }),
    },
    { new: true },
  );

  res.locals.data = {
    message: "Address updated successfully",
    address: updatedAddress,
  };
};

/**
 * Delete user address (Admin)
 */
export const deleteUserAddress = async (req: Request, res: Response) => {
  const { id, addressId } = req.params;

  const address = await UserAddress.findOneAndUpdate(
    { _id: addressId, userId: id, isActive: true },
    { isActive: false },
    { new: true },
  );

  if (!address) {
    return res.status(404).json({
      success: false,
      message: "Address not found",
    });
  }

  res.locals.data = {
    message: "Address deleted successfully",
  };
};

/**
 * Set address as primary (Admin)
 */
export const setAddressPrimary = async (req: Request, res: Response) => {
  const { id, addressId } = req.params;

  // Unselect all addresses for this user
  await UserAddress.updateMany(
    { userId: id, isActive: true },
    { isSelected: false },
  );

  // Set the selected address as primary
  const address = await UserAddress.findOneAndUpdate(
    { _id: addressId, userId: id, isActive: true },
    { isSelected: true },
    { new: true },
  );

  if (!address) {
    return res.status(404).json({
      success: false,
      message: "Address not found",
    });
  }

  res.locals.data = {
    message: "Address set as primary",
    address,
  };
};
