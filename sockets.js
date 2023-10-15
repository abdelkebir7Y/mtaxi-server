const userOrders = {};

const orders = {};

const getOrderRoom = (orderId) => "order-" + orderId;

const addOrderToUser = (uuid, orderId) => {
  if (!userOrders[uuid]) {
    userOrders[uuid] = [];
  }
  userOrders[uuid].push(orderId);
};

const reJoinOrders = (socket) => {
  if (userOrders[socket.uuid]) {
    userOrders[socket.uuid] = userOrders[socket.uuid].filter((orderId) => {
      console.log("rejoin", orderId);

      if (orders[orderId].driversUuids.includes(socket.uuid)) {
        socket.emit("new-order", orders[orderId].notification);
      }
      socket.emit(
        orders[orderId].lastEvent.name,
        ...orders[orderId].lastEvent.data
      );
      const orderRoom = getOrderRoom(orderId);
      socket.join(orderRoom);
      return true;
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
};

const orderAccepted = (orderNamespace) => (orderId, driver) => {
  const orderRoom = getOrderRoom(orderId);
  orderNamespace.in(orderRoom).emit("order-accepted", orderId, driver);
  orders[orderId] = {
    ...orders[orderId],
    driver,
    lastEvent: {
      name: "order-accepted",
      data: [orderId, driver],
    },
  };
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
};

const clientCancel = (orderNamespace) => (orderId) => {
  const orderRoom = getOrderRoom(orderId);
  orderNamespace.in(orderRoom).emit("client-order-canceled", orderId);

  orders[orderId] = {
    ...orders[orderId],
    lastEvent: {
      name: "client-order-canceled",
      data: [orderId],
    },
  };
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
};

const leaveOrder = (socket) => (orderId) => {
  const orderRoom = getOrderRoom(orderId);
  socket.leave(orderRoom);
  userOrders[socket.uuid] = userOrders[socket.uuid].filter(
    (id) => id !== orderId
  );
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
