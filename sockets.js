const { redisClient } = require("./redis-client");

let userOrders = {};

let orders = {};

const getOrderRoom = (orderId) => "order-" + orderId;

const saveOrders = async () => {
  await redisClient.set("orders", JSON.stringify(orders));
};

const saveUserOrders = async () => {
  await redisClient.set("userOrders", JSON.stringify(userOrders));
};

const restoreUserOrders = async () => {
  const userOrdersStr = await redisClient.get("userOrders");
  if (userOrdersStr) {
    userOrders = JSON.parse(userOrdersStr);
  }
};

const restoreOrders = async () => {
  const ordersStr = await redisClient.get("orders");
  if (ordersStr) {
    orders = JSON.parse(ordersStr);
  }
};

// on mount restore orders from redis
restoreOrders();

// on mount restore userOrders from redis
restoreUserOrders();

const addOrderToUser = (uuid, orderId) => {
  if (!userOrders[uuid]) {
    userOrders[uuid] = [];
  }
  userOrders[uuid].push(orderId);
  saveUserOrders();
};

const reJoinOrders = (socket) => {
  if (userOrders[socket.uuid]) {
    userOrders[socket.uuid].forEach((orderId) => {
      if (orders[orderId]) {
        const isClient = socket.uuid === orders[orderId].client?.uuid; // client-uuid
        const isDriver = socket.uuid === orders[orderId].driver?.uuid; // driver-uuid - driver can be null
        const lastEventName = orders[orderId].lastEvent?.name;
        const orderRoom = getOrderRoom(orderId);

        console.log({ rejoin: orderId, isClient, isDriver });

        if (isClient || isDriver) {
          socket.emit(
            orders[orderId].lastEvent.name,
            ...orders[orderId].lastEvent.data
          );
          socket.join(orderRoom);
        } else {
          if (
            ["new-order", "order-accepted", "order-canceled"].includes(
              lastEventName
            )
          ) {
            if (orders[orderId].driversUuids.includes(socket.uuid)) {
              socket.emit("new-order", orders[orderId].notification);
            }

            socket.emit(
              orders[orderId].lastEvent.name,
              ...orders[orderId].lastEvent.data
            );
            socket.join(orderRoom);
          } else {
            leaveOrder(socket)(orderId);
          }
        }
      }
    });
  }
};

const autoCancelOrder = (orderNamespace, orderId) => {
  const orderRoom = getOrderRoom(orderId);
  const cancelCount = orders[orderId]?.cancelCount;
  setTimeout(() => {
    if (
      orders[orderId] &&
      ["new-order", "order-canceled"].includes(
        orders[orderId].lastEvent.name
      ) &&
      cancelCount === orders[orderId].cancelCount
    ) {
      orderNamespace.in(orderRoom).emit("server-cancel-order", orderId);
      orders[orderId].lastEvent = {
        name: "server-cancel-order",
        data: [orderId],
      };
      saveOrders();
    }
  }, 60000);
};

const newConnection = (socket) => {
  const userRoomName = socket.uuid;
  console.log("new connection", userRoomName);
  socket.join(userRoomName);
  reJoinOrders(socket);
};

const bookRide =
  (orderNamespace, socket) => (order, driversUuids, notification) => {
    const orderRoom = getOrderRoom(order.id);
    socket.join(orderRoom);
    addOrderToUser(socket.uuid, order.id);
    driversUuids.forEach((driverUuid) => {
      addOrderToUser(driverUuid, order.id);
      orderNamespace.in(driverUuid).emit("new-order", notification);
    });

    orders[order.id] = {
      notification,
      driversUuids,
      driver: null,
      client: {
        uuid: socket.uuid,
      },
      lastEvent: {
        name: "new-order",
        data: [notification],
      },
      cancelCount: 0,
    };

    saveOrders();
    autoCancelOrder(orderNamespace, order.id);
  };

const receiveOrder = (socket) => (orderId) => {
  const orderRoom = getOrderRoom(orderId);
  socket.join(orderRoom);
  const driversUuids = orders[orderId].driversUuids.filter(
    (uuid) => uuid !== socket.uuid
  );
  orders[orderId] = {
    ...orders[orderId],
    driversUuids,
  };
  saveOrders();
};

const orderAccepted = (orderNamespace) => (orderId, driver, vehicle) => {
  const orderRoom = getOrderRoom(orderId);
  orderNamespace.in(orderRoom).emit("order-accepted", orderId, driver, vehicle);
  orders[orderId] = {
    ...orders[orderId],
    driver,
    lastEvent: {
      name: "order-accepted",
      data: [orderId, driver, vehicle],
    },
  };
  saveOrders();
};

const driverCancel = (orderNamespace) => (orderId) => {
  const orderRoom = getOrderRoom(orderId);
  const driver = orders[orderId].driver;
  orderNamespace.in(orderRoom).emit("order-canceled", orderId, driver);
  orders[orderId] = {
    ...orders[orderId],
    lastEvent: {
      name: "order-canceled",
      data: [orderId, driver],
    },
    driver: null,
    cancelCount: orders[orderId].cancelCount + 1,
  };
  autoCancelOrder(orderNamespace, orderId);
  saveOrders();
};

const clientCancel = (orderNamespace) => (orderId) => {
  const orderRoom = getOrderRoom(orderId);
  const driver = orders[orderId].driver;
  orderNamespace.in(orderRoom).emit("client-order-canceled", orderId, driver);

  orders[orderId] = {
    ...orders[orderId],
    lastEvent: {
      name: "client-order-canceled",
      data: [orderId, driver],
    },
  };
  saveOrders();
};

const pickup = (orderNamespace) => (orderId) => {
  const orderRoom = getOrderRoom(orderId);
  const driver = orders[orderId].driver;
  orderNamespace.in(orderRoom).emit("pickup-client", orderId, driver);

  orders[orderId] = {
    ...orders[orderId],
    lastEvent: {
      name: "pickup-client",
      data: [orderId, driver],
    },
  };
  saveOrders();
};

const complete = (orderNamespace) => (orderId, driver, fare) => {
  const orderRoom = getOrderRoom(orderId);
  orderNamespace.in(orderRoom).emit("complete-order", orderId, driver, fare);

  orders[orderId] = {
    ...orders[orderId],
    lastEvent: {
      name: "complete-order",
      data: [orderId, driver, fare],
    },
  };
  saveOrders();
};

const confirmReservation = (orderNamespace) => (orderId) => {
  const orderRoom = getOrderRoom(orderId);
  const driver = orders[orderId].driver;
  orderNamespace.in(orderRoom).emit("reservation-confirmed", orderId, driver);

  orders[orderId] = {
    ...orders[orderId],
    lastEvent: {
      name: "reservation-confirmed",
      data: [orderId, driver],
    },
  };
  saveOrders();
};

const leaveOrder = (socket) => (orderId) => {
  const orderRoom = getOrderRoom(orderId);
  socket.leave(orderRoom);
  userOrders[socket.uuid] = userOrders[socket.uuid].filter(
    (id) => id !== orderId
  );
  saveUserOrders();
};

function listen(io) {
  const orderNamespace = io.of("/order");
  orderNamespace.use((socket, next) => {
    const uuid = socket.handshake.auth.uuid;

    if (!uuid) {
      return next(new Error("invalid uuid"));
    }

    socket.uuid = uuid;
    next();
  });

  orderNamespace.on("connection", (socket) => {
    newConnection(socket);

    socket.on("book-ride", bookRide(orderNamespace, socket));

    socket.on("receive-order", receiveOrder(socket));

    socket.on("accept-order", orderAccepted(orderNamespace));

    socket.on("driver-cancel", driverCancel(orderNamespace));

    socket.on("client-cancel", clientCancel(orderNamespace));

    socket.on("pickup", pickup(orderNamespace));

    socket.on("complete", complete(orderNamespace));

    socket.on("leave-order", leaveOrder(socket));

    socket.on("confirm-reservation", confirmReservation(orderNamespace));

    socket.on("online", () => {
      console.log("online", socket.uuid);
    });

    socket.on("disconnect", (reason) => {
      console.log(`Client ${socket.uuid} disconnected: ${reason}`);
    });
  });
}

module.exports = {
  listen,
};
