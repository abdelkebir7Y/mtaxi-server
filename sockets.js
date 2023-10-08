const pendingInvites = {};

const newConnection = (socket) => {
  const userRoomName = socket.uuid;
  socket.join(userRoomName);
};

const bookRide =
  (orderNamespace, socket) => (order, driversUuids, notification) => {
    const orderRoom = "order" + order.id;
    socket.join(orderRoom);
    driversUuids.forEach((driverUuid) => {
      console.log("driver uuid", driverUuid);
      orderNamespace.in(driverUuid).emit("new-order", notification);
    });

    pendingInvites[order.id] = { driversUuids, order, lastEvent: "new-order" };
  };

const receiveOrder = (socket) => (orderId) => {
  const orderRoom = "order" + orderId;
  socket.join(orderRoom);
  pendingInvites[orderId].driversUuids = pendingInvites[
    orderId
  ].driversUuids.filter((uuid) => uuid !== socket.uuid);
};

const orderAccepted = (orderNamespace) => (orderId, driver) => {
  const orderRoom = "order" + orderId;
  orderNamespace.in(orderRoom).emit("order-accepted", orderId, driver);
};

const driverCancel = (orderNamespace, socket) => (orderId) => {
  const orderRoom = "order" + orderId;
  socket.leave(orderRoom);
  orderNamespace.in(orderRoom).emit("order-canceled", orderId);
};

const clientCancel = (orderNamespace) => (orderId) => {
  console.log("client cancel order", orderId);
  const orderRoom = "order" + orderId;
  orderNamespace.in(orderRoom).emit("client-order-canceled", orderId);
};

const complete = (orderNamespace) => (orderId, driver, fare) => {
  const orderRoom = "order" + orderId;
  orderNamespace.in(orderRoom).emit("complete-order", orderId, driver, fare);
  orderNamespace.in(orderRoom).socketsLeave(orderRoom);
};

const pickup = (orderNamespace, socket) => (orderId, clientUuid) => {
  const orderRoom = "order" + orderId;

  orderNamespace
    .in(orderRoom)
    .fetchSockets()
    .then((sockets) => {
      sockets.forEach((_s) => {
        /**
         * change 123 with client uuid
         */
        if (_s.uuid !== socket.uuid && _s.uuid !== "123") {
          _s.leave(orderRoom);
        }
      });
      orderNamespace.in(orderRoom).emit("pickup-client", orderId);
    });
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

    socket.on("driver-cancel", driverCancel(orderNamespace, socket));

    socket.on("client-cancel", clientCancel(orderNamespace));

    socket.on("pickup", pickup(orderNamespace, socket));

    socket.on("complete", complete(orderNamespace));

    socket.on("disconnect", (reason) => {
      console.log(`Client ${socket.id} disconnected: ${reason}`);
    });
  });
}

module.exports = {
  listen,
};
