(function (root, factory) {
  const loyalty = factory();
  if (typeof module === "object" && module.exports) module.exports = loyalty;
  else root.MmhLoyalty = loyalty;
})(globalThis, function () {
  const signupPoints = 20;
  const qualifyingPurchasePoints = 20;
  const qualifyingPurchaseMinimum = 5000;
  const firstPurchaseDiscount = 10;
  const levels = [
    { name: "Cliente nuevo", key: "new", discountPercent: 0 },
    { name: "Cliente distinguido", key: "distinguished", pointsThreshold: 100, discountPercent: 12 },
    { name: "Cliente VIP", key: "vip", spendThreshold: 70000, discountPercent: 15 },
    { name: "Cliente legendario", key: "legendary", spendThreshold: 100000, discountPercent: 17 },
    { name: "Cliente épico", key: "epic", spendThreshold: 150000, discountPercent: 17 },
    { name: "Cliente master", key: "master", spendThreshold: 200000, discountPercent: 20 },
    { name: "Cliente challenger", key: "challenger", spendThreshold: 500000, discountPercent: 30, supplierPricing: true },
    { name: "Cliente Gran Challenger Emprendedor", key: "grand-challenger", spendThreshold: 1000000, discountPercent: 35, supplierPricing: true, specialMedal: true }
  ];

  function calculateLoyalty(orders = []) {
    const verifiedOrders = orders.filter(order =>
      (order.paymentStatus || order.payment_status) === "Pago verificado"
    );
    const verifiedSpend = verifiedOrders.reduce((sum, order) => {
      const subtotal = Number(order.subtotal ?? order.total);
      return sum + (Number.isFinite(subtotal) && subtotal > 0 ? subtotal : 0);
    }, 0);
    const qualifyingPurchases = verifiedOrders.filter(order =>
      Number(order.subtotal ?? order.total) > qualifyingPurchaseMinimum
    ).length;
    const points = signupPoints + qualifyingPurchases * qualifyingPurchasePoints;
    let levelIndex = points >= 100 ? 1 : 0;

    levels.forEach((level, index) => {
      if (level.spendThreshold && verifiedSpend >= level.spendThreshold) levelIndex = index;
    });

    const level = levels[levelIndex];
    const nextSpendLevel = levels.find(candidate =>
      candidate.spendThreshold && candidate.spendThreshold > verifiedSpend
    ) || null;

    return {
      points,
      qualifyingPurchases,
      verifiedPurchases: verifiedOrders.length,
      verifiedSpend,
      hasVerifiedPurchase: verifiedOrders.length > 0,
      level,
      levelIndex,
      discountPercent: verifiedOrders.length ? level.discountPercent : firstPurchaseDiscount,
      firstPurchaseAvailable: verifiedOrders.length === 0,
      nextSpendLevel,
      pointProgress: Math.min(100, Math.round(points / 100 * 100)),
      spendProgress: nextSpendLevel
        ? Math.min(100, Math.round(verifiedSpend / nextSpendLevel.spendThreshold * 100))
        : 100
    };
  }

  return {
    signupPoints,
    qualifyingPurchasePoints,
    qualifyingPurchaseMinimum,
    firstPurchaseDiscount,
    levels,
    calculateLoyalty
  };
});
